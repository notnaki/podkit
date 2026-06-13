import { describe, it, expect } from "vitest";
import { cloudCommand } from "../src/commands/cloud.ts";

describe("cloudCommand argument validation", () => {
  it("rejects an unknown subcommand", async () => {
    const res = await cloudCommand(["bogus"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects a missing subcommand", async () => {
    const res = await cloudCommand([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects create without a slug", async () => {
    const res = await cloudCommand(["create"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects deploy without a slug", async () => {
    const res = await cloudCommand(["deploy"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects url without a slug", async () => {
    const res = await cloudCommand(["url"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });
});
