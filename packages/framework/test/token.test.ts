import { describe, it, expect } from "vitest";
import { extractToken } from "../src/request/token.ts";

describe("extractToken", () => {
  it("returns the bearer token from an authorization header", () => {
    expect(extractToken({ authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("matches the Authorization header key case-insensitively", () => {
    expect(extractToken({ Authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("matches the Bearer scheme case-insensitively and trims the token", () => {
    expect(extractToken({ authorization: "bearer   abc123  " })).toBe("abc123");
  });

  it("parses the podkit_session cookie when no bearer is present", () => {
    expect(extractToken({ cookie: "podkit_session=xyz; other=1" })).toBe("xyz");
  });

  it("percent-decodes the cookie value (inverse of serializeCookie)", () => {
    expect(extractToken({ cookie: "podkit_session=a%20b%3Bc" })).toBe("a b;c");
  });

  it("lets the bearer token win when both are present", () => {
    expect(
      extractToken({ authorization: "Bearer abc123", cookie: "podkit_session=xyz" }),
    ).toBe("abc123");
  });

  it("returns null for an empty headers object", () => {
    expect(extractToken({})).toBeNull();
  });

  it("returns null when the cookie has no podkit_session entry", () => {
    expect(extractToken({ cookie: "other=1" })).toBeNull();
  });
});
