import { describe, it, expect } from "vitest";
import { buildRouteTable } from "../src/routing/discover.ts";
import { matchRoute } from "../src/routing/match.ts";

const table = buildRouteTable([
  "index.tsx",
  "about.tsx",
  "blog/[slug].tsx",
  "docs/[...path].tsx",
]);

describe("matchRoute", () => {
  it("matches a static route with no params", () => {
    const m = matchRoute(table, "/about");
    expect(m?.route.file).toBe("about.tsx");
    expect(m?.params).toEqual({});
  });

  it("matches a dynamic segment and extracts the param", () => {
    const m = matchRoute(table, "/blog/hello-world");
    expect(m?.route.file).toBe("blog/[slug].tsx");
    expect(m?.params).toEqual({ slug: "hello-world" });
  });

  it("matches a catch-all and joins the remaining segments", () => {
    const m = matchRoute(table, "/docs/guides/getting-started");
    expect(m?.route.file).toBe("docs/[...path].tsx");
    expect(m?.params).toEqual({ path: "guides/getting-started" });
  });

  it("prefers a static match over a dynamic one", () => {
    const t = buildRouteTable(["blog/[slug].tsx", "blog/feed.tsx"]);
    const m = matchRoute(t, "/blog/feed");
    expect(m?.route.file).toBe("blog/feed.tsx");
  });

  it("returns null when nothing matches", () => {
    expect(matchRoute(table, "/nope/deep/path")).toBeNull();
  });
});
