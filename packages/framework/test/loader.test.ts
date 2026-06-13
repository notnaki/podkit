import { describe, it, expect } from "vitest";
import { runLoader } from "../src/loader/run.ts";

describe("runLoader", () => {
  it("returns {} when the module has no loader", async () => {
    const data = await runLoader({}, { params: {}, url: new URL("http://x/") });
    expect(data).toEqual({});
  });

  it("awaits the loader and returns its data with context available", async () => {
    const mod = { loader: async (ctx: { params: Record<string, string> }) => ({ slug: ctx.params.slug }) };
    const data = await runLoader(mod, { params: { slug: "hi" }, url: new URL("http://x/blog/hi") });
    expect(data).toEqual({ slug: "hi" });
  });
});
