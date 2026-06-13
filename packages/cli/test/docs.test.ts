import { describe, it, expect } from "vitest";
import { docsCommand } from "../src/commands/docs.ts";

describe("docsCommand", () => {
  it("returns a doc for a known topic", async () => {
    const res = await docsCommand(["routing"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { topic: string }).topic).toBe("routing");
    }
  });

  it("fails with E_BAD_ARGS for an unknown topic", async () => {
    const res = await docsCommand(["nope"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("E_BAD_ARGS");
    }
  });

  it("lists topics when no arg given", async () => {
    const res = await docsCommand([]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const topics = (res.data as { topics: string[] }).topics;
      expect(Array.isArray(topics)).toBe(true);
      expect(topics.length).toBeGreaterThan(0);
    }
  });

  it("describes the project for the 'project' subcommand", async () => {
    const res = await docsCommand(["project"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Array.isArray((res.data as { routes: unknown[] }).routes)).toBe(true);
    }
  });
});
