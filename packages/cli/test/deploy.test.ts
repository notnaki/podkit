import { describe, it, expect } from "vitest";
import { deployCommand } from "../src/commands/deploy.ts";

describe("deployCommand argument validation", () => {
  it("rejects an unknown subcommand", async () => {
    const res = await deployCommand(["bogus"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects a missing subcommand", async () => {
    const res = await deployCommand([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects promote without a version id", async () => {
    const res = await deployCommand(["promote"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects claim without an owner", async () => {
    const res = await deployCommand(["claim"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });
});
