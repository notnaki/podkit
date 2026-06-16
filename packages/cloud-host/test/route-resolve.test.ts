import { describe, it, expect } from "vitest";
import { resolveRouteKey } from "../src/host.ts";

const empty = new Map<string, string>();

describe("resolveRouteKey", () => {
  it("prefers the /_p/<key> path (prod and preview keys)", () => {
    expect(resolveRouteKey("anything", "/_p/notes/", empty, "localhost")).toBe("notes");
    expect(resolveRouteKey("x", "/_p/notes--staging/foo", empty, "localhost")).toBe("notes--staging");
  });

  it("resolves the wildcard <key>.<appsDomain> subdomain at the root", () => {
    expect(resolveRouteKey("notes.localhost", "/", empty, "localhost")).toBe("notes");
    expect(resolveRouteKey("notes.localhost:8090", "/login", empty, "localhost")).toBe("notes");
    expect(resolveRouteKey("notes--staging.localhost", "/", empty, "localhost")).toBe("notes--staging");
  });

  it("works with a production apps domain", () => {
    expect(resolveRouteKey("notes.apps.podkit.dev", "/", empty, "apps.podkit.dev")).toBe("notes");
  });

  it("honors an exact custom-domain match before the wildcard", () => {
    const map = new Map([["my-notes.com", "notes"]]);
    expect(resolveRouteKey("my-notes.com", "/", map, "localhost")).toBe("notes");
  });

  it("returns null for unrelated hosts and multi-level labels", () => {
    expect(resolveRouteKey("example.com", "/", empty, "localhost")).toBeNull();
    expect(resolveRouteKey("localhost", "/", empty, "localhost")).toBeNull();
    // a.b.localhost is two subdomain levels — not one of our route keys
    expect(resolveRouteKey("a.b.localhost", "/", empty, "localhost")).toBeNull();
  });
});
