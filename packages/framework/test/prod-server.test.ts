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
  expect(result.routeCount).toBe(9);
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

  it("wraps every route in the root _layout", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    expect(body).toContain('<div data-layout="root">');
    expect(body).toContain("site nav");
    expect(body).toContain("podkit home");
  });

  it("nests a route's _layout chain root → leaf", async () => {
    const res = await fetch(`${base}/blog/hello`);
    const body = await res.text();
    // root layout outside the blog layout, blog layout outside the post.
    expect(body).toMatch(
      /data-layout="root">.*data-layout="blog">.*post: hello.*<\/section>.*<\/div>/s,
    );
  });

  it("runs each layout's own loader and embeds layout data for hydration", async () => {
    const res = await fetch(`${base}/blog/hello`);
    const body = await res.text();
    expect(body).toContain("<h2>Blog</h2>");
    expect(body).toContain('window.__PODKIT_LAYOUT_DATA__ = [{},{"section":"Blog"}]');
  });

  it("returns SPA {route,data,layoutData} JSON for x-podkit-data:1", async () => {
    const res = await fetch(`${base}/blog/hello`, { headers: { "x-podkit-data": "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.route).toBe("blog/[slug].tsx");
    expect(body.data).toEqual({ slug: "hello" });
    expect(body.layoutData).toEqual([{}, { section: "Blog" }]);
  });
});

describe("prod build output", () => {
  it("writes one pre-compiled SSR module per route", () => {
    const manifest = JSON.parse(
      readFileSync(join(buildDir, "build-manifest.json"), "utf8"),
    ) as { routes: { serverFile: string }[] };
    expect(manifest.routes).toHaveLength(9);
    for (const route of manifest.routes) {
      const mod = readFileSync(join(buildDir, "server", route.serverFile), "utf8");
      expect(mod.length).toBeGreaterThan(0);
    }
  });
});

describe("prerender + ISR", () => {
  type ManifestRoute = { pattern: string; prerender?: string; revalidate?: number };
  function manifestRoutes(): ManifestRoute[] {
    return (
      JSON.parse(readFileSync(join(buildDir, "build-manifest.json"), "utf8")) as {
        routes: ManifestRoute[];
      }
    ).routes;
  }

  it("prerenders param-less prerender=true routes to static HTML at build", () => {
    const route = manifestRoutes().find((r) => r.pattern === "/static-page")!;
    expect(route.prerender).toBe("prerendered/static-page.html");
    const html = readFileSync(join(buildDir, route.prerender!), "utf8");
    expect(html).toContain("<h1>Static Page</h1>");
    expect(html).toContain('<div id="root">');
  });

  it("serves the prerendered HTML directly", async () => {
    const res = await fetch(`${base}/static-page`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Static Page</h1>");
  });

  it("records the revalidate window in the manifest", () => {
    const route = manifestRoutes().find((r) => r.pattern === "/isr-page")!;
    expect(route.revalidate).toBe(0);
    expect(route.prerender).toBe("prerendered/isr-page.html");
  });

  it("serves cached HTML and re-renders in the background (stale-while-revalidate)", async () => {
    // hits is embedded in the data script; read it from there (the rendered
    // text node carries a React comment marker: "isr hits: <!-- -->N").
    const hitsOf = (html: string) =>
      Number(JSON.parse(html.match(/__PODKIT_DATA__ = (\{.*?\});/)![1]).hits);
    // First hit: served from the build-time prerendered HTML (hits: 1 at build).
    const first = await (await fetch(`${base}/isr-page`)).text();
    expect(hitsOf(first)).toBe(1);
    // revalidate=0 => the first request also triggers a background re-render.
    // Poll until the cache reflects a newer render (hits incremented).
    let latest = first;
    for (let i = 0; i < 20 && hitsOf(latest) === 1; i++) {
      await new Promise((r) => setTimeout(r, 25));
      latest = await (await fetch(`${base}/isr-page`)).text();
    }
    expect(hitsOf(latest)).toBeGreaterThanOrEqual(2);
  });
});
