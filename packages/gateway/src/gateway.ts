import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type Resolver = (req: {
  host: string;
  path: string;
}) => { hostPort: number; host?: string; slug?: string | null } | null;

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
      opts.onRequest?.({
        slug,
        statusCode: 502,
        latencyMs: Date.now() - requestStart,
      });
      if (!res.headersSent) {
        // Log the real cause server-side for debugging, but never leak internal
        // upstream details (loopback ports, container DNS names) to clients.
        console.error("gateway upstream error:", err.message);
        fail(res, 502, "E_UPSTREAM", "Upstream request failed");
      } else {
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
