import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { verifyToken } from "@podkit/auth";
import { createSink } from "@podkit/telemetry";
import { matchRoute } from "../routing/match.ts";
import { runLoader } from "../loader/run.ts";
import { renderPage } from "../render/ssr.ts";
import { extractToken } from "../request/token.ts";
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
  for (const r of manifest.routes) serverFileByPattern.set(r.pattern, r.serverFile);

  // Cache imported modules across requests (the files never change at runtime).
  const moduleCache = new Map<string, RouteModule>();

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
      let mod = moduleCache.get(serverFile);
      if (!mod) {
        const modPath = join(serverDir, serverFile);
        // @vite-ignore — these are pre-built ESM files imported via Node's loader.
        mod = (await import(pathToFileURL(modPath).href)) as RouteModule;
        moduleCache.set(serverFile, mod);
      }
      const data = await runLoader(mod, { params: m.params, url, auth });
      const html = await renderPage(mod, data, manifest.clientEntry);
      status = 200;
      res.statusCode = 200;
      res.setHeader("content-type", "text/html");
      res.end(html);
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
