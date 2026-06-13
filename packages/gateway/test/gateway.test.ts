import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createGateway, type Resolver } from "../src/index.ts";

let upstream: Server;
let upstreamPort: number;
let gateway: ReturnType<typeof createGateway>;
let gatewayUrl: string;

beforeAll(async () => {
  // Tiny upstream that echoes the url it received as JSON.
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, resolve));
  const addr = upstream.address();
  upstreamPort = typeof addr === "object" && addr ? addr.port : 0;

  const resolve: Resolver = ({ path }) =>
    path.startsWith("/_p/demo/") || path === "/_p/demo"
      ? { hostPort: upstreamPort }
      : null;

  gateway = createGateway({ resolve });
  const listened = await gateway.listen(0);
  gatewayUrl = listened.url;
}, 30000);

afterAll(async () => {
  await gateway.close();
  await new Promise<void>((resolve, reject) =>
    upstream.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("createGateway", () => {
  it(
    "proxies /_p/demo/hello and strips the /_p/demo prefix",
    async () => {
      const res = await fetch(gatewayUrl + "/_p/demo/hello");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBe("/hello");
    },
    30000,
  );

  it(
    "returns 502 E_NO_ROUTE for an unknown slug",
    async () => {
      const res = await fetch(gatewayUrl + "/_p/unknown/x");
      expect(res.status).toBe(502);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("E_NO_ROUTE");
    },
    30000,
  );
});
