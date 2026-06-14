import { describe, it, expect } from "vitest";
import { cloudCommand } from "../src/commands/cloud.ts";

describe("cloudCommand status argument validation", () => {
  it("rejects status without a slug", async () => {
    const res = await cloudCommand(["status"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });
});
