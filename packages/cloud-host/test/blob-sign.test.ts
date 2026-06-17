import { describe, it, expect } from "vitest";
import { signBlob, verifyBlob } from "../src/blob-sign.ts";

const SECRET = "test-secret-abc123";
const PROJECT_ID = "proj-uuid-1234";
const KEY = "images/logo.png";
const NOW = 1_700_000_000_000; // fixed epoch ms
const EXP = NOW + 3600_000; // +1 hour

describe("signBlob / verifyBlob", () => {
  it("round-trip: a fresh token verifies", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    expect(verifyBlob(PROJECT_ID, KEY, EXP, sig, SECRET, NOW)).toBe(true);
  });

  it("tampered sig fails", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    const tampered = sig.slice(0, -4) + "XXXX";
    expect(verifyBlob(PROJECT_ID, KEY, EXP, tampered, SECRET, NOW)).toBe(false);
  });

  it("expired token fails (nowMs > expMs)", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    expect(verifyBlob(PROJECT_ID, KEY, EXP, sig, SECRET, EXP + 1)).toBe(false);
  });

  it("token is not valid at exact expiry ms (boundary: expired)", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    expect(verifyBlob(PROJECT_ID, KEY, EXP, sig, SECRET, EXP)).toBe(false);
  });

  it("wrong key fails", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    expect(verifyBlob(PROJECT_ID, "other/key.png", EXP, sig, SECRET, NOW)).toBe(false);
  });

  it("wrong projectId fails", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    expect(verifyBlob("other-project", KEY, EXP, sig, SECRET, NOW)).toBe(false);
  });

  it("wrong secret fails", () => {
    const sig = signBlob(PROJECT_ID, KEY, EXP, SECRET);
    expect(verifyBlob(PROJECT_ID, KEY, EXP, sig, "wrong-secret", NOW)).toBe(false);
  });
});
