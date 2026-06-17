import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

// A resolved route is one of:
//  - a live upstream the gateway proxies to,
//  - `sleeping`: the project exists but its container is scaled to zero, so the
//    gateway wakes it (via onColdStart) and serves a holding page meanwhile,
//  - null: no such route (502).
export type RouteResolution =
  | { hostPort: number; host?: string; slug?: string | null }
  | { sleeping: true; slug: string };

export type Resolver = (req: { host: string; path: string }) => RouteResolution | null;

// Observability hook invoked once per request with non-sensitive metadata only:
// the resolved project slug (or null), the response status class, and the
// latency. Bodies, headers, and paths are never passed here.
export type RequestObserver = (m: {
  slug: string | null;
  statusCode: number;
  latencyMs: number;
}) => void;

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ ok: false, error: { code, message } });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

// Cold-start holding page: the project's container is asleep and being woken.
// 503 + Retry-After + a meta-refresh so the browser polls until it's up.
// ponytail: meta-refresh polling (~2s), no WebSocket/SSE progress. Upgrade:
// push readiness over SSE and swap to the app without a full reload.
function serveHoldingPage(res: ServerResponse): void {
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="2"><title>Starting…</title>' +
    "<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;" +
    "height:100vh;margin:0;background:#0b0b0c;color:#e8e8ea}.box{text-align:center}" +
    ".spinner{width:32px;height:32px;border:3px solid #2a2a2e;border-top-color:#8b5cf6;" +
    "border-radius:50%;margin:0 auto 16px;animation:spin .8s linear infinite}" +
    "@keyframes spin{to{transform:rotate(360deg)}}h1{font-size:16px;font-weight:600;margin:0}" +
    "p{font-size:13px;color:#9a9aa2;margin:6px 0 0}</style></head><body><div class=\"box\">" +
    '<div class="spinner"></div><h1>Starting up…</h1>' +
    "<p>This app was asleep and is waking. The page will refresh automatically.</p>" +
    "</div></body></html>";
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "2" });
  res.end(html);
}

// Path-based routing: `/_p/<slug>/...` extracts <slug> and strips the
// `/_p/<slug>` prefix so the upstream sees the remaining path (default "/").
function stripPathPrefix(path: string): string {
  const match = /^\/_p\/[^/]+(\/.*)?$/.exec(path);
  if (!match) return path;
  const rest = match[1];
  return rest && rest.length > 0 ? rest : "/";
}

export function createGateway(opts: {
  resolve: Resolver;
  onRequest?: RequestObserver;
  // Invoked when a request hits a scaled-to-zero project, to kick off a wake.
  // Fire-and-forget from the gateway's view; the implementation dedupes.
  onColdStart?: (slug: string) => void;
  // Invoked when the upstream is unreachable (container stopped/crashed out of
  // band) — lets the control-plane drop the stale route and recover. Returns
  // true if recovery is under way (serve the holding page), false to 502.
  onUpstreamError?: (slug: string) => boolean;
}): {
  listen(port: number): Promise<{ url: string }>;
  close(): Promise<void>;
} {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    const path = req.url ?? "/";
    const requestStart = Date.now();
    const route = opts.resolve({ host, path });
    if (!route) {
      // No route resolved: we still couldn't determine a slug, so report null.
      opts.onRequest?.({
        slug: null,
        statusCode: 502,
        latencyMs: Date.now() - requestStart,
      });
      fail(res, 502, "E_NO_ROUTE", "No route found");
      return;
    }
    if ("sleeping" in route) {
      // Cold start: kick off the wake and hold the browser with an auto-refresh
      // page until the container is up and the route resolves to a live upstream.
      opts.onColdStart?.(route.slug);
      serveHoldingPage(res);
      opts.onRequest?.({
        slug: route.slug,
        statusCode: 503,
        latencyMs: Date.now() - requestStart,
      });
      return;
    }
    const slug = route.slug ?? null;

    const strippedPath = stripPathPrefix(path);
    const upstream = httpRequest(
      {
        // host defaults to localhost (host-mode: app published on the host's
        // loopback). In container mode the resolver returns the app container's
        // name, reachable over the shared Docker network by its embedded DNS.
        host: route.host ?? "localhost",
        port: route.hostPort,
        method: req.method,
        path: strippedPath,
        headers: req.headers,
      },
      (upRes: IncomingMessage) => {
        opts.onRequest?.({
          slug,
          statusCode: upRes.statusCode ?? 502,
          latencyMs: Date.now() - requestStart,
        });
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err: Error) => {
      if (!res.headersSent) {
        // A connection-level failure means the container is gone (stopped,
        // crashed, OOM-killed, host rebooted) while the route still pointed at
        // it. Ask the control-plane to drop the stale route and recover; if it
        // kicks a cold start, hold the browser instead of surfacing a 502.
        const recovering = slug ? opts.onUpstreamError?.(slug) === true : false;
        if (recovering) {
          serveHoldingPage(res);
          opts.onRequest?.({ slug, statusCode: 503, latencyMs: Date.now() - requestStart });
          return;
        }
        // Log the real cause server-side for debugging, but never leak internal
        // upstream details (loopback ports, container DNS names) to clients.
        console.error("gateway upstream error:", err.message);
        opts.onRequest?.({ slug, statusCode: 502, latencyMs: Date.now() - requestStart });
        fail(res, 502, "E_UPSTREAM", "Upstream request failed");
      } else {
        opts.onRequest?.({ slug, statusCode: 502, latencyMs: Date.now() - requestStart });
        res.destroy();
      }
    });
    req.pipe(upstream);
  });

  return {
    listen(port: number): Promise<{ url: string }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolve({ url: "http://localhost:" + actualPort });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
