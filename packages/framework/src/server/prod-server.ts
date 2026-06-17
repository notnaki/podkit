import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { verifyToken } from "@podkit/auth";
import { createSink } from "@podkit/telemetry";
import { matchRoute } from "../routing/match.ts";
import { runLoader } from "../loader/run.ts";
import { renderPage, renderPageToStream } from "../render/ssr.ts";
import { extractToken } from "../request/token.ts";
import { handleAction } from "../request/respond.ts";
import { buildRequestEvent } from "../request/log.ts";
import { readManifest } from "../build/manifest.ts";
import type { Route } from "../types.ts";
import type { RouteModule } from "../loader/run.ts";

export interface ProdServerOptions {
  appRoot: string;
  buildDir: string;
  port?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot) : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Production server. Unlike the dev server it does NOT use Vite at runtime:
 *  - Route modules are pre-compiled SSR ESM files imported via dynamic import().
 *  - Client assets (hashed JS/CSS) are served from <buildDir>/client with
 *    immutable cache headers.
 * Route matching, loader execution and SSR rendering reuse the same code paths
 * as the dev server, so behaviour is identical.
 */
export async function createProdServer(opts: ProdServerOptions) {
  const manifestPath = join(opts.buildDir, "build-manifest.json");
  const manifest = readManifest(manifestPath);

  const clientDir = join(opts.buildDir, manifest.clientDir);
  const serverDir = join(opts.buildDir, manifest.serverDir);

  const table: Route[] = manifest.routes.map((r) => ({
    pattern: r.pattern,
    kind: r.kind,
    file: r.file,
    params: r.params,
  }));
  const serverFileByPattern = new Map<string, string>();
  const layoutsByPattern = new Map<string, string[]>();
  const prerenderByPattern = new Map<string, string>();
  const revalidateByPattern = new Map<string, number>();
  for (const r of manifest.routes) {
    serverFileByPattern.set(r.pattern, r.serverFile);
    layoutsByPattern.set(r.pattern, r.layouts ?? []);
    if (r.prerender) prerenderByPattern.set(r.pattern, r.prerender);
    if (typeof r.revalidate === "number") revalidateByPattern.set(r.pattern, r.revalidate);
  }

  // In-process ISR cache: pathname -> { html, renderedAt(ms) }. Prerendered HTML
  // seeds it lazily on first hit. When a route has a `revalidate` window we serve
  // the cached HTML immediately and, if it is older than the window, kick off a
  // background re-render (stale-while-revalidate).
  // ponytail: single-process in-memory cache — no shared store, lost on restart,
  // not coordinated across replicas. Upgrade: back it with Redis/KV keyed by
  // pathname + a per-render lock so only one replica revalidates at a time.
  const isrCache = new Map<string, { html: string; renderedAt: number }>();
  const revalidating = new Set<string>();

  // Cache imported modules across requests (the files never change at runtime).
  const moduleCache = new Map<string, RouteModule>();

  async function loadModule(serverFile: string): Promise<RouteModule> {
    let mod = moduleCache.get(serverFile);
    if (!mod) {
      const modPath = join(serverDir, serverFile);
      // @vite-ignore — these are pre-built ESM files imported via Node's loader.
      mod = (await import(pathToFileURL(modPath).href)) as RouteModule;
      moduleCache.set(serverFile, mod);
    }
    return mod;
  }

  // Render a route to a full HTML string (used by the ISR cache, which stores
  // strings so it can serve stale copies without re-rendering).
  async function renderRouteHtml(pattern: string, file: string, url: URL): Promise<string> {
    const serverFile = serverFileByPattern.get(pattern);
    if (!serverFile) throw new Error("no compiled module for route: " + pattern);
    const mod = await loadModule(serverFile);
    const ctx = { params: {}, url, auth: null };
    const data = await runLoader(mod, ctx);
    const layoutMods = await Promise.all(
      (layoutsByPattern.get(pattern) ?? []).map((lf) => loadModule(lf)),
    );
    const layoutData = await Promise.all(layoutMods.map((lm) => runLoader(lm, ctx)));
    return renderPage(mod, data, manifest.clientEntry, file, layoutMods, layoutData);
  }

  const sink = createSink({ file: join(opts.appRoot, ".podkit/telemetry/events.jsonl") });

  function serveStatic(pathname: string, res: import("node:http").ServerResponse): boolean {
    // pathname starts with "/client/". Strip the leading "/client" prefix.
    const rel = pathname.slice(manifest.clientDir.length + 1); // remove "/" + clientDir
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const full = join(clientDir, safe);
    if (!full.startsWith(clientDir)) return false;
    if (!existsSync(full) || !statSync(full).isFile()) return false;
    res.statusCode = 200;
    res.setHeader("content-type", contentTypeFor(full));
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.end(readFileSync(full));
    return true;
  }

  const http: Server = createHttpServer(async (req, res) => {
    const start = Date.now();
    const requestId = randomBytes(6).toString("hex");
    const url = new URL(req.url ?? "/", "http://localhost");

    // Static client assets.
    if (url.pathname.startsWith("/" + manifest.clientDir + "/")) {
      if (serveStatic(url.pathname, res)) return;
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const token = extractToken(req.headers);
    const secret = process.env.PODKIT_AUTH_SECRET ?? "podkit-dev-secret";
    let auth: { userId: string; isAgent: boolean } | null = null;
    if (token) {
      const payload = verifyToken(token, secret);
      if (payload && typeof payload.userId === "string") {
        auth = { userId: payload.userId, isAgent: payload.kind === "agent" };
      }
    }

    let status = 200;
    try {
      const m = matchRoute(table, url.pathname);
      if (!m) {
        status = 404;
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const serverFile = serverFileByPattern.get(m.route.pattern);
      if (!serverFile) {
        throw new Error("no compiled module for route: " + m.route.pattern);
      }
      const mod = await loadModule(serverFile);
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        status = await handleAction(req, res, mod, { params: m.params, url, auth, method });
        return;
      }

      // Prerender / ISR — only for prerendered (param-less) routes on GET/HEAD.
      const prerenderFile = prerenderByPattern.get(m.route.pattern);
      if (prerenderFile) {
        const revalidate = revalidateByPattern.get(m.route.pattern);
        const key = url.pathname;
        const now = Date.now();
        let entry = isrCache.get(key);
        if (!entry) {
          // Seed from the on-disk prerendered HTML (rendered at build time).
          const html = readFileSync(join(opts.buildDir, prerenderFile), "utf8");
          entry = { html, renderedAt: now };
          isrCache.set(key, entry);
        }
        // ISR: serve stale, re-render in the background past the window.
        if (
          typeof revalidate === "number" &&
          now - entry.renderedAt > revalidate * 1000 &&
          !revalidating.has(key)
        ) {
          revalidating.add(key);
          void renderRouteHtml(m.route.pattern, m.route.file, url)
            .then((html) => isrCache.set(key, { html, renderedAt: Date.now() }))
            .catch(() => {
              /* keep serving the stale copy on re-render failure */
            })
            .finally(() => revalidating.delete(key));
        }
        status = 200;
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(entry.html);
        return;
      }

      const ctx = { params: m.params, url, auth };
      const data = await runLoader(mod, ctx);
      const layoutMods = await Promise.all(
        (layoutsByPattern.get(m.route.pattern) ?? []).map((lf) => loadModule(lf)),
      );
      // Each layout runs its own loader with the same ctx as the page.
      const layoutData = await Promise.all(layoutMods.map((lm) => runLoader(lm, ctx)));
      // Stream the HTML response (head -> React shell -> tail).
      status = 200;
      renderPageToStream(res, mod, data, manifest.clientEntry, m.route.file, layoutMods, layoutData);
    } catch (err) {
      status = 500;
      res.statusCode = 500;
      res.end(err instanceof Error ? err.stack : String(err));
    } finally {
      try {
        sink.append(buildRequestEvent({
          method: req.method ?? "GET",
          path: url.pathname,
          status,
          durationMs: Date.now() - start,
          requestId,
          identity: auth?.userId,
        }));
      } catch {
        // Logging must never break a response.
      }
    }
  });

  return {
    routeCount: table.length,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => http.listen(opts.port ?? 3000, resolve));
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      return `http://localhost:${port}`;
    },
    async close() {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
