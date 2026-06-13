import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyticsCommand } from "../src/commands/analytics.ts";
import { logsCommand } from "../src/commands/logs.ts";

describe("analyticsCommand", () => {
  it("fails with E_BAD_ARGS for an unknown subcommand", async () => {
    const result = await analyticsCommand(["bogus"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });

  it("fails with E_BAD_ARGS for a missing subcommand", async () => {
    const result = await analyticsCommand([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });
});

describe("logsCommand", () => {
  it("returns ok with empty events when no sink exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "podkit-logs-"));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const result = await logsCommand([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.data as { events: unknown[] }).events).toEqual([]);
      }
    } finally {
      process.chdir(prev);
    }
  });
});
