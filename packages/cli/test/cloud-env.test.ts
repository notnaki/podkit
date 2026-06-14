import { describe, it, expect } from "vitest";
import { cloudCommand } from "../src/commands/cloud.ts";

describe("cloudCommand env argument validation", () => {
  it("rejects env with no action", async () => {
    const res = await cloudCommand(["env"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects env set with no slug", async () => {
    const res = await cloudCommand(["env", "set"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects env set with a token lacking '='", async () => {
    const res = await cloudCommand(["env", "set", "myapp", "NOTKV"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects env rm with no key", async () => {
    const res = await cloudCommand(["env", "rm", "myapp"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects an unknown env action", async () => {
    const res = await cloudCommand(["env", "bogus"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });
});
