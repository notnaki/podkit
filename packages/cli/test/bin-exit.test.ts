import { describe, it, expect } from "vitest";
import { exitCodeFor } from "../src/errors.ts";

describe("exitCodeFor", () => {
  it("maps E_BAD_ARGS to 2", () => {
    expect(exitCodeFor("E_BAD_ARGS")).toBe(2);
  });

  it("maps E_NOT_IMPLEMENTED to 5", () => {
    expect(exitCodeFor("E_NOT_IMPLEMENTED")).toBe(5);
  });

  it("maps network/auth/unknown to 1", () => {
    for (const c of ["E_NETWORK", "E_UNAUTHORIZED", "E_UNKNOWN", "E_NO_ROUTES"]) {
      expect(exitCodeFor(c)).toBe(1);
    }
  });

  it("defaults unrecognized codes to 1", () => {
    expect(exitCodeFor("E_NONSENSE")).toBe(1);
  });
});
