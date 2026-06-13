import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
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
});
