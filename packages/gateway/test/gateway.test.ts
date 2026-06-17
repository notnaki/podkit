import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createGateway, type Resolver } from "../src/index.ts";

let upstream: Server;
let upstreamPort: number;
let deadPort: number;
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

  // Reserve a port, then release it so connections to it are refused.
  const dead = createServer();
  await new Promise<void>((resolve) => dead.listen(0, resolve));
  const deadAddr = dead.address();
  deadPort = typeof deadAddr === "object" && deadAddr ? deadAddr.port : 0;
  await new Promise<void>((resolve, reject) =>
    dead.close((err) => (err ? reject(err) : resolve())),
  );

  const resolve: Resolver = ({ path }) => {
    if (path.startsWith("/_p/demo/") || path === "/_p/demo") {
      return { hostPort: upstreamPort };
    }
    // Route /_p/dead/* to a port nothing is listening on, to trigger an
    // upstream connection error (ECONNREFUSED).
    if (path.startsWith("/_p/dead/") || path === "/_p/dead") {
      return { hostPort: deadPort };
    }
    return null;
  };

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
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("E_NO_ROUTE");
      // The error message must not reflect the attacker-controlled host/path.
      expect(body.error.message).toBe("No route found");
      expect(body.error.message).not.toContain("/_p/unknown");
    },
    30000,
  );

  it(
    "returns 502 E_UPSTREAM without leaking internal upstream details",
    async () => {
      const res = await fetch(gatewayUrl + "/_p/dead/x");
      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("E_UPSTREAM");
      // Must not leak the internal port number or the underlying error cause.
      expect(body.error.message).toBe("Upstream request failed");
      expect(body.error.message).not.toContain(String(deadPort));
      expect(body.error.message).not.toMatch(/ECONNREFUSED|ENOTFOUND|connect/i);
    },
    30000,
  );
});

describe("createGateway — cold start", () => {
  it(
    "serves a holding page and triggers onColdStart for a sleeping route",
    async () => {
      const woken: string[] = [];
      const g = createGateway({
        resolve: ({ path }) =>
          path.startsWith("/_p/asleep") ? { sleeping: true, slug: "asleep" } : null,
        onColdStart: (slug) => woken.push(slug),
      });
      const { url } = await g.listen(0);
      try {
        const res = await fetch(url + "/_p/asleep/", { redirect: "manual" });
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("2");
        const body = await res.text();
        expect(body).toContain('http-equiv="refresh"');
        expect(body).toContain("Starting up");
        // The wake was kicked off exactly once for the resolved slug.
        expect(woken).toEqual(["asleep"]);
      } finally {
        await g.close();
      }
    },
    30000,
  );
});
