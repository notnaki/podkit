import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type Resolver = (req: {
  host: string;
  path: string;
}) => { hostPort: number } | null;

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

export function createGateway(opts: { resolve: Resolver }): {
  listen(port: number): Promise<{ url: string }>;
  close(): Promise<void>;
} {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    const path = req.url ?? "/";
    const route = opts.resolve({ host, path });
    if (!route) {
      fail(res, 502, "E_NO_ROUTE", "No route for host=" + host + " path=" + path);
      return;
    }

    const strippedPath = stripPathPrefix(path);
    const upstream = httpRequest(
      {
        host: "localhost",
        port: route.hostPort,
        method: req.method,
        path: strippedPath,
        headers: req.headers,
      },
      (upRes: IncomingMessage) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err: Error) => {
      if (!res.headersSent) {
        fail(res, 502, "E_UPSTREAM", "Upstream request failed: " + err.message);
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
