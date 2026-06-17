import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDevServer } from "../src/server/dev-server.ts";

const appRoot = fileURLToPath(new URL("../../../examples/hello", import.meta.url));
const server = await createDevServer({ appRoot, port: 0 });
const base = await server.listen();

afterAll(async () => { await server.close(); });

describe("dev server", () => {
  it("serves SSR html for the index route", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("podkit home");
    expect(body).toContain('<div id="root">');
  });

  it("renders a dynamic route with loader data embedded", async () => {
    const res = await fetch(`${base}/blog/hello`);
    const body = await res.text();
    expect(body).toContain("post: hello");
    expect(body).toContain('window.__PODKIT_DATA__ = {"slug":"hello"}');
  });

  it("renders a catch-all route", async () => {
    const res = await fetch(`${base}/docs/a/b/c`);
    const body = await res.text();
    expect(body).toContain("docs: a/b/c");
  });

  it("returns 404 for an unmatched path", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("wires the client hydration entry + route id, and strips server code in dev", async () => {
    const html = await (await fetch(`${base}/counter`)).text();
    expect(html).toContain('window.__PODKIT_ROUTE__ = "counter.tsx"');
    expect(html).toContain('src="/.podkit/client-entry.tsx"');
    // The dev-transformed client module must not carry the loader's node:crypto.
    const mod = await (await fetch(`${base}/app/routes/counter.tsx`)).text();
    expect(mod).not.toContain("node:crypto");
    expect(mod).not.toContain("randomUUID");
  });

  it("wraps routes in the root _layout and nests deeper layouts", async () => {
    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain('<div data-layout="root">');
    expect(home).toContain("site nav");

    const post = await (await fetch(`${base}/blog/hello`)).text();
    expect(post).toMatch(
      /data-layout="root">.*data-layout="blog">.*post: hello.*<\/section>.*<\/div>/s,
    );
  });
});

describe("dev server — actions", () => {
  it("runs a route's action on POST: 303 redirect + Set-Cookie", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "message=hello+world%21",
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/echo?said=hello%20world!");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("podkit_echo=hello%20world!");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("the loader reads the redirected query on the follow-up GET", async () => {
    const res = await fetch(`${base}/echo?said=greetings`);
    const body = await res.text();
    expect(body).toContain("said: greetings");
  });

  it("returns 405 for a non-GET request to a route without an action", async () => {
    const res = await fetch(`${base}/about`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(405);
  });

  it("returns 413 when the body exceeds the 1 MiB cap", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "message=" + "x".repeat(1024 * 1024 + 16),
      redirect: "manual",
    });
    expect(res.status).toBe(413);
  });
});

describe("dev server — empty routes dir", () => {
  it("resolves with routeCount === 0 and does not throw when app/routes is missing", async () => {
    const emptyRoot = mkdtempSync(tmpdir() + "/podkit-test-");
    const emptyServer = await createDevServer({ appRoot: emptyRoot, port: 0 });
    try {
      expect(emptyServer.routeCount).toBe(0);
    } finally {
      await emptyServer.close();
    }
  });
});
