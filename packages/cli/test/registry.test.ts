import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/registry.ts";

describe("registry", () => {
  it("dispatches to a registered command and returns its envelope", async () => {
    const reg = createRegistry();
    reg.register("dev", async (args) => ({ ok: true, data: { args } }));
    const result = await reg.dispatch(["dev", "--port", "4000"]);
    expect(result).toEqual({ ok: true, data: { args: ["--port", "4000"] } });
  });

  it("returns E_BAD_ARGS for an unknown command", async () => {
    const reg = createRegistry();
    const result = await reg.dispatch(["nope"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_BAD_ARGS");
  });

  it("returns E_BAD_ARGS when no command is given", async () => {
    const reg = createRegistry();
    const result = await reg.dispatch([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_BAD_ARGS");
  });
});
