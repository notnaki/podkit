import { describe, it, expect } from "vitest";
import { createElement, Suspense, use } from "react";
import type { ServerResponse } from "node:http";
import { renderPage, renderPageToStream } from "../src/render/ssr.ts";

// Collect everything written to a ServerResponse-shaped sink.
function fakeRes() {
  let body = "";
  const res = {
    statusCode: 0,
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    write(chunk: unknown) {
      body += String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) body += String(chunk);
      this.writableEnded = true;
    },
    get body() {
      return body;
    },
  };
  return res;
}

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

describe("renderPageToStream", () => {
  function streamToString(
    mod: Parameters<typeof renderPageToStream>[1],
    data: unknown,
    layouts: Parameters<typeof renderPageToStream>[5] = [],
    layoutData: unknown[] = [],
  ): Promise<string> {
    return new Promise((resolve) => {
      const res = fakeRes();
      const origEnd = res.end.bind(res);
      res.end = (chunk?: unknown) => {
        origEnd(chunk);
        resolve(res.body);
      };
      renderPageToStream(
        res as unknown as ServerResponse,
        mod,
        data,
        "/entry.js",
        "index.tsx",
        layouts,
        layoutData,
      );
    });
  }

  it("streams head -> shell -> tail with the page markup and data scripts", async () => {
    const mod = {
      default: (p: { data: { name: string } }) =>
        createElement("h1", null, `Hi ${p.data.name}`),
    };
    const html = await streamToString(mod, { name: "podkit" });
    expect(html).toContain('<div id="root">');
    expect(html).toContain("Hi podkit");
    expect(html).toContain('window.__PODKIT_DATA__ = {"name":"podkit"}');
    expect(html).toContain('window.__PODKIT_ROUTE__ = "index.tsx"');
    expect(html).toContain('src="/entry.js"');
    // Order: root opens before the closing tag + script tail.
    expect(html.indexOf('<div id="root">')).toBeLessThan(html.indexOf("</div><script>"));
  });

  it("streams a <Suspense> boundary: fallback first, then resolved content, then the data tail", async () => {
    // A component that suspends on a promise that resolves AFTER the shell flush,
    // so React emits the fallback in the shell and streams the resolved HTML
    // (in its hidden swap <div>) afterward.
    let pending: Promise<string> | null = null;
    function Async() {
      if (!pending) pending = new Promise((r) => setTimeout(() => r("RESOLVED_CONTENT"), 30));
      return createElement("p", null, use(pending));
    }
    const page = {
      default: () =>
        createElement(
          "div",
          null,
          createElement("h1", null, "SHELL"),
          createElement(
            Suspense,
            { fallback: createElement("span", null, "FALLBACK_MARKER") },
            createElement(Async),
          ),
        ),
    };
    const html = await streamToString(page, { from: "loader" });
    // Both the fallback (flushed in the shell) and the streamed resolved content.
    expect(html).toContain("FALLBACK_MARKER");
    expect(html).toContain("RESOLVED_CONTENT");
    // The hydration data tail is still emitted, and AFTER all streamed content.
    expect(html).toContain('window.__PODKIT_DATA__ = {"from":"loader"}');
    expect(html.indexOf("RESOLVED_CONTENT")).toBeLessThan(
      html.indexOf("window.__PODKIT_DATA__"),
    );
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("passes each layout its own data when streaming", async () => {
    const page = {
      default: (p: { data: { tag: string } }) => createElement("main", null, p.data.tag),
    };
    const layout = {
      default: (p: { data: { lt: string }; children: unknown }) =>
        createElement("div", null, p.data.lt, p.children as never),
    };
    const html = await streamToString(page, { tag: "P" }, [layout], [{ lt: "L" }]);
    expect(html).toContain("L");
    expect(html).toContain("P");
    expect(html).toContain('window.__PODKIT_LAYOUT_DATA__ = [{"lt":"L"}]');
  });
});
