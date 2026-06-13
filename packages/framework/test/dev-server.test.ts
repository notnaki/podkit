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
