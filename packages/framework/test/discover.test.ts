import { describe, it, expect } from "vitest";
import { buildRouteTable, findLayouts } from "../src/routing/discover.ts";

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

  it("ignores dotfiles and macOS AppleDouble sidecars (._*)", () => {
    const table = buildRouteTable([
      "index.tsx",
      "._index.tsx", // AppleDouble sidecar from a macOS-made tarball
      ".keep.tsx",
      "blog/._post.tsx",
    ]);
    expect(table).toEqual([
      { pattern: "/", kind: "static", file: "index.tsx", params: [] },
    ]);
  });
});

describe("findLayouts", () => {
  const files = [
    "_layout.tsx",
    "index.tsx",
    "blog/_layout.tsx",
    "blog/[slug].tsx",
    "blog/drafts/index.tsx",
  ];

  it("returns the root layout for a top-level route", () => {
    expect(findLayouts(files, "index.tsx")).toEqual(["_layout.tsx"]);
  });

  it("chains root → nested layouts, outermost first", () => {
    expect(findLayouts(files, "blog/[slug].tsx")).toEqual([
      "_layout.tsx",
      "blog/_layout.tsx",
    ]);
  });

  it("includes only the layouts that exist along the path", () => {
    // blog/drafts has no _layout, so only root + blog apply
    expect(findLayouts(files, "blog/drafts/index.tsx")).toEqual([
      "_layout.tsx",
      "blog/_layout.tsx",
    ]);
  });

  it("returns [] when no layouts exist", () => {
    expect(findLayouts(["index.tsx"], "index.tsx")).toEqual([]);
  });
});
