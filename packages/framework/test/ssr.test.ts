import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderPage } from "../src/render/ssr.ts";

describe("renderPage", () => {
  it("renders the default component with loader data and embeds the data script", async () => {
    const mod = {
      default: (props: { data: { name: string } }) =>
        createElement("h1", null, `Hello ${props.data.name}`),
    };
    const html = await renderPage(mod, { name: "podkit" }, "/app/entry-client.tsx");
    expect(html).toContain("<h1>Hello podkit</h1>");
    expect(html).toContain('window.__PODKIT_DATA__ = {"name":"podkit"}');
    expect(html).toContain('<div id="root">');
    expect(html).toContain('src="/app/entry-client.tsx"');
  });

  it("renders an empty root when the module has no default export", async () => {
    const html = await renderPage({}, {}, "/app/entry-client.tsx");
    expect(html).toContain('<div id="root"></div>');
  });
});
