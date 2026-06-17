import { createServer as createViteServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { podkitPlugins, CLIENT_ENTRY_SOURCE } from "../build/plugin.ts";
import { randomBytes } from "node:crypto";
import { verifyToken } from "@podkit/auth";
import { createSink } from "@podkit/telemetry";
import { buildRouteTable, findLayouts } from "../routing/discover.ts";
import { matchRoute } from "../routing/match.ts";
import { runLoader } from "../loader/run.ts";
import { renderPageToStream } from "../render/ssr.ts";
import { extractToken } from "../request/token.ts";
import { handleAction } from "../request/respond.ts";
import { buildRequestEvent } from "../request/log.ts";
import type { RouteModule } from "../loader/run.ts";

function listFiles(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else out.push(relative(root, full));
  }
  return out;
}

export interface DevServerOptions {
  appRoot: string;
  port?: number;
}

export async function createDevServer(opts: DevServerOptions) {
  const routesDir = join(opts.appRoot, "app", "routes");
  const allFiles = listFiles(routesDir).map((f) => f.split("\\").join("/"));
  const table = buildRouteTable(allFiles);

  // The framework owns the client entry (hydration bootstrap); write it under
  // .podkit so Vite can serve + transform it like any app file.
  const podkitDir = join(opts.appRoot, ".podkit");
  mkdirSync(podkitDir, { recursive: true });
  writeFileSync(join(podkitDir, "client-entry.tsx"), CLIENT_ENTRY_SOURCE);

  const vite: ViteDevServer = await createViteServer({
    root: opts.appRoot,
    plugins: [react(), ...(podkitPlugins(opts.appRoot) as never[])],
    appType: "custom",
    // Give HMR's websocket a unique high port instead of Vite's fixed default
    // (24678). The fixed port collides when multiple dev servers run at once
    // (e.g. parallel tests / multiple apps), logging "Port 24678 is already in
    // use" and causing intermittent suite flakiness. Vite treats both
    // `hmr:false` and `hmr.port:0` as "use the default" in middlewareMode, so we
    // pick a random high port per server (collision odds are negligible).
    server: {
      middlewareMode: true,
      hmr: { port: 25000 + Math.floor(Math.random() * 20000) },
    },
  });

  const clientEntry = "/.podkit/client-entry.tsx";

  const sink = createSink({ file: join(opts.appRoot, ".podkit/telemetry/events.jsonl") });

  const http: Server = createHttpServer((req, res) => {
    vite.middlewares(req, res, async () => {
      const start = Date.now();
      const requestId = randomBytes(6).toString("hex");

      const token = extractToken(req.headers);
      const secret = process.env.PODKIT_AUTH_SECRET ?? "podkit-dev-secret";
      let auth: { userId: string; isAgent: boolean } | null = null;
      if (token) {
        const payload = verifyToken(token, secret);
        if (payload && typeof payload.userId === "string") {
          auth = { userId: payload.userId, isAgent: payload.kind === "agent" };
        }
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      let status = 200;
      try {
        const m = matchRoute(table, url.pathname);
        if (!m) {
          status = 404;
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const mod = (await vite.ssrLoadModule(join(routesDir, m.route.file))) as RouteModule;
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD") {
          status = await handleAction(req, res, mod, { params: m.params, url, auth, method });
          return;
        }
        const ctx = { params: m.params, url, auth };
        const data = await runLoader(mod, ctx);
        const layoutMods = (await Promise.all(
          findLayouts(allFiles, m.route.file).map(
            (lf) => vite.ssrLoadModule(join(routesDir, lf)) as Promise<RouteModule>,
          ),
        ));
        // Each layout runs its own loader with the same ctx as the page.
        const layoutData = await Promise.all(layoutMods.map((lm) => runLoader(lm, ctx)));
        // SPA navigation data request: same match/loader path, JSON instead of
        // HTML. The route id matches the client route table key (the source file).
        if (req.headers["x-podkit-data"] === "1") {
          status = 200;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ route: m.route.file, data, layoutData }));
          return;
        }
        // Stream the HTML response (head -> React shell -> tail).
        status = 200;
        renderPageToStream(res, mod, data, clientEntry, m.route.file, layoutMods, layoutData);
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
      await vite.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
