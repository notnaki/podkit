import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.ts";

describe("password hashing", () => {
  const sample = "correct-horse-battery-staple";

  it("verifies a correct password against its hash", () => {
    expect(verifyPassword(sample, hashPassword(sample))).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyPassword("wrong", hashPassword(sample))).toBe(false);
  });

  it("produces a different hash each time (random salt)", () => {
    expect(hashPassword(sample)).not.toBe(hashPassword(sample));
  });

  it("returns false (no throw) for malformed stored value", () => {
    expect(verifyPassword("x", "garbage-not-a-valid-hash")).toBe(false);
  });
});
