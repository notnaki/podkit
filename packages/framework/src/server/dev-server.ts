import { createServer as createViteServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { createServer as createHttpServer, type Server } from "node:http";
import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { buildRouteTable } from "../routing/discover.ts";
import { matchRoute } from "../routing/match.ts";
import { runLoader } from "../loader/run.ts";
import { renderPage } from "../render/ssr.ts";
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
  const table = buildRouteTable(listFiles(routesDir).map((f) => f.split("\\").join("/")));

  const vite: ViteDevServer = await createViteServer({
    root: opts.appRoot,
    plugins: [react()],
    appType: "custom",
    server: { middlewareMode: true },
  });

  const clientEntry = "/app/entry-client.tsx";

  const http: Server = createHttpServer((req, res) => {
    vite.middlewares(req, res, async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const m = matchRoute(table, url.pathname);
        if (!m) { res.statusCode = 404; res.end("Not found"); return; }
        const mod = (await vite.ssrLoadModule(join(routesDir, m.route.file))) as RouteModule;
        const data = await runLoader(mod, { params: m.params, url });
        const html = await renderPage(mod, data, clientEntry);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(html);
      } catch (err) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.stack : String(err));
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
