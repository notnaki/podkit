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

  it("passes loader data to layouts", async () => {
    const page = { default: () => createElement("main", null, "p") };
    const layout = {
      default: (p: { data: { tag: string }; children: unknown }) =>
        createElement("div", null, p.data.tag, p.children as never),
    };
    const html = await renderPage(page, { tag: "T" }, "/e.js", "index.tsx", [layout]);
    expect(html).toContain("<div>T<main>p</main></div>");
  });
});
