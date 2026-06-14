import { describe, it, expect } from "vitest";
import { cloudCommand } from "../src/commands/cloud.ts";

describe("cloudCommand domains argument validation", () => {
  it("rejects domains with no action", async () => {
    const res = await cloudCommand(["domains"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects domains add with no slug", async () => {
    const res = await cloudCommand(["domains", "add"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects domains add with a slug but no domain", async () => {
    const res = await cloudCommand(["domains", "add", "myapp"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects domains rm with no domain", async () => {
    const res = await cloudCommand(["domains", "rm", "myapp"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });
});
