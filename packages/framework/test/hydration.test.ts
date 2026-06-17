// @vitest-environment jsdom
import { TextEncoder, TextDecoder } from "node:util";
import { Buffer } from "node:buffer";
// jsdom installs realm-mismatched TextEncoder/Uint8Array that trip esbuild's
// `encode("") instanceof Uint8Array` invariant; restore Node's (Buffer extends
// Node's Uint8Array, so its prototype chain yields the original) so buildApp
// (Vite/esbuild) can run inside this jsdom-environment file.
globalThis.TextEncoder = TextEncoder as unknown as typeof globalThis.TextEncoder;
globalThis.TextDecoder = TextDecoder as unknown as typeof globalThis.TextDecoder;
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype)
  .constructor as Uint8ArrayConstructor;

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "node:url";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createProdServer } from "../src/server/prod-server.ts";
// buildApp pulls in vite/esbuild at module-eval; import it dynamically (not
// hoisted) so the TextEncoder fix above is in place first.

// process.cwd() is the repo root (jsdom's import.meta.url isn't a file URL).
const appRoot = join(process.cwd(), "examples", "hello");
const buildDir = join(appRoot, ".podkit", `build-hydrate-${randomBytes(4).toString("hex")}`);
mkdirSync(buildDir, { recursive: true });

let base: string;
let server: Awaited<ReturnType<typeof createProdServer>>;
let entryFile: string;

beforeAll(async () => {
  const { buildApp } = await import("../src/build/app.ts");
  const result = await buildApp(appRoot, buildDir);
  entryFile = result.clientEntry.replace(/^\/client\//, "");
  server = await createProdServer({ appRoot, buildDir, port: 0 });
  base = await server.listen();
}, 60000);

afterAll(async () => {
  await server.close();
  rmSync(buildDir, { recursive: true, force: true });
});

// Booleans the framework wires into a real browser. Here we drive the *actual*
// built client bundle against jsdom to prove hydration produces interactivity.
describe("client hydration", () => {
  it("strips server-only code from the client bundle", () => {
    const clientDir = join(buildDir, "client");
    const bundle = readdirSync(clientDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(clientDir, f), "utf8"))
      .join("\n");
    // The counter route's loader imports node:crypto + calls randomUUID — both
    // must be gone from the browser bundle.
    expect(bundle).not.toContain("node:crypto");
    expect(bundle).not.toContain("randomUUID");
  });

  it("hydrates the server-rendered markup into an interactive component", async () => {
    // Render the page on the server exactly as a browser would receive it.
    const html = await (await fetch(`${base}/counter`)).text();
    const rootInner = html.match(/<div id="root">([\s\S]*?)<\/div><script>/)![1];
    const data = JSON.parse(html.match(/__PODKIT_DATA__ = ([\s\S]*?);window\.__PODKIT_ROUTE__/)![1]);
    const route = JSON.parse(html.match(/__PODKIT_ROUTE__ = ([\s\S]*?)<\/script>/)![1]);

    // Recreate the browser's starting state: server HTML in #root + globals.
    document.body.innerHTML = `<div id="root">${rootInner}</div>`;
    const w = window as unknown as { __PODKIT_DATA__: unknown; __PODKIT_ROUTE__: string };
    w.__PODKIT_DATA__ = data;
    w.__PODKIT_ROUTE__ = route;
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

    const button = document.querySelector("button")!;
    // Server-rendered start value (loader returned start: 3).
    expect(button.textContent).toContain("count:3");

    // Run the real built client entry — its top-level code hydrates #root.
    await import(pathToFileURL(join(buildDir, "client", entryFile)).href);
    await new Promise((r) => setTimeout(r, 50));

    // After hydration the click handler is live: clicking updates React state.
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("button")!.textContent).toContain("count:4");
  });
});
