import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
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

  it("adds iat and exp claims when ttlSeconds is provided", () => {
    const payload = { userId: "u1", role: "admin" };
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(payload, "s", 3600); // 1 hour TTL

    const result = verifyToken(token, "s");
    expect(result).not.toBeNull();
    expect(result!["userId"]).toBe("u1");
    expect(result!["role"]).toBe("admin");
    expect(typeof result!["iat"]).toBe("number");
    expect(typeof result!["exp"]).toBe("number");
    expect((result!["exp"] as number) - (result!["iat"] as number)).toBe(3600);
    expect(result!["iat"] as number).toBeGreaterThanOrEqual(now - 1);
    expect(result!["iat"] as number).toBeLessThanOrEqual(now + 1);
  });

  it("returns null when token is expired", () => {
    const pastTime = Math.floor(Date.now() / 1000) - 1000; // 1000 seconds ago

    // Manually craft a token with past exp (for testing only)
    const testPayload = { userId: "u1", iat: pastTime - 3600, exp: pastTime };
    const body = Buffer.from(JSON.stringify(testPayload)).toString("base64url");
    const sig = Buffer.from(
      createHmac("sha256", "s").update(body).digest()
    ).toString("base64url");
    const expiredToken = `${body}.${sig}`;

    expect(verifyToken(expiredToken, "s")).toBeNull();
  });

  it("verifies tokens without exp claim (backward compatibility)", () => {
    const payload = { userId: "u1", kind: "session" };
    const token = signToken(payload, "s"); // No TTL

    const result = verifyToken(token, "s");
    expect(result).toEqual(payload);
    expect(result!["exp"]).toBeUndefined();
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

  it("produces an expiring token when ttlSeconds is provided", () => {
    const token = issueAgentToken({ userId: "u1", scopes: ["read"] }, "s", 86400); // 1 day TTL
    const result = verifyToken(token, "s");

    expect(result).not.toBeNull();
    expect(result!["kind"]).toBe("agent");
    expect(result!["userId"]).toBe("u1");
    expect(result!["scopes"]).toEqual(["read"]);
    expect(typeof result!["iat"]).toBe("number");
    expect(typeof result!["exp"]).toBe("number");
    expect((result!["exp"] as number) - (result!["iat"] as number)).toBe(86400);
  });
});
