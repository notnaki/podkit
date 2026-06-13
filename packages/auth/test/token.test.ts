import { describe, it, expect } from "vitest";
import {
  signToken,
  verifyToken,
  issueAgentToken,
} from "../src/token.ts";

describe("signToken / verifyToken", () => {
  it("round-trips a payload correctly", () => {
    const payload = { userId: "u1", role: "admin" };
    const token = signToken(payload, "s");
    expect(verifyToken(token, "s")).toEqual(payload);
  });

  it("returns null for the wrong secret", () => {
    const token = signToken({ userId: "u1" }, "correct");
    expect(verifyToken(token, "wrong")).toBeNull();
  });

  it("returns null for a tampered body", () => {
    const token = signToken({ userId: "u1" }, "s");
    const [body, sig] = token.split(".");
    // Mutate the first character of the body
    const tampered = body!.slice(0, -1) + (body!.endsWith("a") ? "b" : "a");
    expect(verifyToken(`${tampered}.${sig}`, "s")).toBeNull();
  });

  it("returns null for malformed input without throwing", () => {
    expect(() => verifyToken("not-a-token", "s")).not.toThrow();
    expect(verifyToken("not-a-token", "s")).toBeNull();
  });
});

describe("issueAgentToken", () => {
  it("produces a token that verifies with kind, userId, and scopes", () => {
    const token = issueAgentToken({ userId: "u1", scopes: ["read"] }, "s");
    const result = verifyToken(token, "s");
    expect(result).not.toBeNull();
    expect(result!["kind"]).toBe("agent");
    expect(result!["userId"]).toBe("u1");
    expect(result!["scopes"]).toEqual(["read"]);
  });
});
