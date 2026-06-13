import { describe, it, expect } from "vitest";
import { buildRouteTable } from "../src/routing/discover.ts";

describe("buildRouteTable", () => {
  it("maps index, static, dynamic, and catch-all files to patterns", () => {
    const table = buildRouteTable([
      "index.tsx",
      "about.tsx",
      "blog/[slug].tsx",
      "docs/[...path].tsx",
    ]);
    expect(table).toEqual([
      { pattern: "/", kind: "static", file: "index.tsx", params: [] },
      { pattern: "/about", kind: "static", file: "about.tsx", params: [] },
      { pattern: "/blog/:slug", kind: "dynamic", file: "blog/[slug].tsx", params: ["slug"] },
      { pattern: "/docs/*path", kind: "catchall", file: "docs/[...path].tsx", params: ["path"] },
    ]);
  });

  it("ignores non-route files and normalizes nested index", () => {
    const table = buildRouteTable(["dashboard/index.tsx", "README.md", "_helper.ts"]);
    expect(table).toEqual([
      { pattern: "/dashboard", kind: "static", file: "dashboard/index.tsx", params: [] },
    ]);
  });
});
