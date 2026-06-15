import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { buildApp } from "../src/build/app.ts";
import { createProdServer } from "../src/server/prod-server.ts";

const appRoot = fileURLToPath(new URL("../../../examples/hello", import.meta.url));
// Build INSIDE the example app so the externalized SSR modules can resolve
// `react`/`react-dom` from the app's node_modules (mirrors the container layout
// where the build dir lives under the app root).
const buildDir = join(appRoot, ".podkit", `build-test-${randomBytes(4).toString("hex")}`);
mkdirSync(buildDir, { recursive: true });

let base: string;
let server: Awaited<ReturnType<typeof createProdServer>>;
let clientEntry: string;

beforeAll(async () => {
  const result = await buildApp(appRoot, buildDir);
  expect(result.routeCount).toBe(6);
  expect(result.clientEntry).toMatch(/^\/client\/entry-[A-Za-z0-9_-]+\.js$/);
  clientEntry = result.clientEntry;
  server = await createProdServer({ appRoot, buildDir, port: 0 });
  base = await server.listen();
}, 60000);

afterAll(async () => {
  await server.close();
  rmSync(buildDir, { recursive: true, force: true });
});

describe("prod server", () => {
  it("serves SSR html for the index route from the pre-built module", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("podkit home");
    expect(body).toContain('<div id="root">');
  });

  it("emits the hashed client entry script tag from the manifest", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    expect(body).toContain(`<script type="module" src="${clientEntry}">`);
    expect(body).toMatch(/<script type="module" src="\/client\/entry-[A-Za-z0-9_-]+\.js">/);
  });

  it("renders a dynamic route with loader data embedded", async () => {
    const res = await fetch(`${base}/blog/hello`);
    const body = await res.text();
    expect(body).toContain("post: hello");
    expect(body).toContain('window.__PODKIT_DATA__ = {"slug":"hello"}');
  });

  it("renders a catch-all route with the joined path", async () => {
    const res = await fetch(`${base}/docs/a/b/c`);
    const body = await res.text();
    expect(body).toContain("docs: a/b/c");
  });

  it("returns 404 for an unmatched path", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("serves the hashed client asset with an immutable cache header", async () => {
    const res = await fetch(`${base}${clientEntry}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("returns 404 for a missing client asset", async () => {
    const res = await fetch(`${base}/client/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it("does not load Vite at runtime (the asset is plain pre-built JS)", async () => {
    const built = readFileSync(join(buildDir, "build-manifest.json"), "utf8");
    expect(built).not.toContain("ssrLoadModule");
  });

  it("runs a pre-compiled route's action on POST: 303 + Set-Cookie", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "message=prod%20ok",
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/echo?said=prod%20ok");
    expect(res.headers.get("set-cookie") ?? "").toContain("podkit_echo=prod%20ok");
  });

  it("returns 405 for a non-GET request to a route without an action", async () => {
    const res = await fetch(`${base}/about`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(405);
  });
});

describe("prod build output", () => {
  it("writes one pre-compiled SSR module per route", () => {
    const manifest = JSON.parse(
      readFileSync(join(buildDir, "build-manifest.json"), "utf8"),
    ) as { routes: { serverFile: string }[] };
    expect(manifest.routes).toHaveLength(6);
    for (const route of manifest.routes) {
      const mod = readFileSync(join(buildDir, "server", route.serverFile), "utf8");
      expect(mod.length).toBeGreaterThan(0);
    }
  });
});
