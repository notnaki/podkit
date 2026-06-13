import { describe, it, expect } from "vitest";
import { ok, fail } from "../src/envelope.ts";
import { PodkitError } from "../src/errors.ts";

describe("envelope", () => {
  it("wraps success data with ok:true", () => {
    expect(ok({ port: 3000 })).toEqual({ ok: true, data: { port: 3000 } });
  });

  it("wraps a PodkitError with code, message, and hint", () => {
    const err = new PodkitError("E_NO_ROUTES", "No routes found", "Create app/routes/index.tsx");
    expect(fail(err)).toEqual({
      ok: false,
      error: { code: "E_NO_ROUTES", message: "No routes found", hint: "Create app/routes/index.tsx" },
    });
  });

  it("wraps an unknown error as E_UNKNOWN without a hint", () => {
    expect(fail(new Error("boom"))).toEqual({
      ok: false,
      error: { code: "E_UNKNOWN", message: "boom", hint: undefined },
    });
  });
});
