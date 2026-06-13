import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { devCommand } from "../src/commands/dev.ts";

describe("devCommand", () => {
  let originalCwd: string;

  afterEach(() => {
    if (originalCwd) process.chdir(originalCwd);
  });

  it("returns E_NO_ROUTES when run against a directory with no routes", async () => {
    originalCwd = process.cwd();
    const emptyRoot = mkdtempSync(tmpdir() + "/podkit-cli-test-");
    process.chdir(emptyRoot);
    const result = await devCommand([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_NO_ROUTES");
    }
  });

  it("returns E_BAD_ARGS when --port is not a valid integer", async () => {
    const result = await devCommand(["--port", "notanumber"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });
});
