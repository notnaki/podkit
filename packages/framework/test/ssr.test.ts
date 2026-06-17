import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderPage } from "../src/render/ssr.ts";

describe("renderPage", () => {
  it("renders the default component with loader data and embeds the data script", async () => {
    const mod = {
      default: (props: { data: { name: string } }) =>
        createElement("h1", null, `Hello ${props.data.name}`),
    };
    const html = await renderPage(mod, { name: "podkit" }, "/entry.js", "index.tsx");
    expect(html).toContain("<h1>Hello podkit</h1>");
    expect(html).toContain('window.__PODKIT_DATA__ = {"name":"podkit"}');
    expect(html).toContain('window.__PODKIT_ROUTE__ = "index.tsx"');
    expect(html).toContain('<div id="root">');
    expect(html).toContain('src="/entry.js"');
  });

  it("renders an empty root when the module has no default export", async () => {
    const html = await renderPage({}, {}, "/entry.js", "index.tsx");
    expect(html).toContain('<div id="root"></div>');
  });

  it("wraps the page in the layout chain, outermost first", async () => {
    const page = {
      default: (p: { data: { name: string } }) =>
        createElement("main", null, p.data.name),
    };
    const root = {
      default: (p: { children: unknown }) =>
        createElement("div", { "data-l": "root" }, p.children as never),
    };
    const inner = {
      default: (p: { children: unknown }) =>
        createElement("section", { "data-l": "inner" }, p.children as never),
    };
    const html = await renderPage(page, { name: "x" }, "/e.js", "index.tsx", [root, inner]);
    // root outermost, inner inside it, page innermost.
    expect(html).toMatch(
      /<div data-l="root"><section data-l="inner"><main>x<\/main><\/section><\/div>/,
    );
  });

  it("passes each layout its OWN loader data (not the page data)", async () => {
    const page = {
      default: (p: { data: { tag: string } }) => createElement("main", null, p.data.tag),
    };
    const layout = {
      default: (p: { data: { lt: string }; children: unknown }) =>
        createElement("div", null, p.data.lt, p.children as never),
    };
    // Page data and layout data differ: layout must render its own ("L"), page "P".
    const html = await renderPage(
      page,
      { tag: "P" },
      "/e.js",
      "index.tsx",
      [layout],
      [{ lt: "L" }],
    );
    expect(html).toContain("<div>L<main>P</main></div>");
    // Layout data is embedded for hydration.
    expect(html).toContain('window.__PODKIT_LAYOUT_DATA__ = [{"lt":"L"}]');
  });

  it("embeds an empty layout-data array when no layouts have loaders", async () => {
    const mod = { default: () => createElement("h1", null, "x") };
    const html = await renderPage(mod, {}, "/e.js", "index.tsx");
    expect(html).toContain("window.__PODKIT_LAYOUT_DATA__ = []");
  });
});
