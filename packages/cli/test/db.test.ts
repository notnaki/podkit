import { describe, it, expect } from "vitest";
import { dbCommand } from "../src/commands/db.ts";

describe("dbCommand", () => {
  it("returns E_BAD_ARGS for an unknown subcommand", async () => {
    const result = await dbCommand(["bogus"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });

  it("returns E_BAD_ARGS when no subcommand is given", async () => {
    const result = await dbCommand([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });

  it("returns E_NOT_IMPLEMENTED for studio subcommand", async () => {
    const result = await dbCommand(["studio"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_NOT_IMPLEMENTED");
    }
  });
});
