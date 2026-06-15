import { describe, it, expect } from "vitest";
import { serializeCookie } from "../src/request/cookie.ts";

describe("serializeCookie", () => {
  it("serializes a basic cookie with secure defaults (HttpOnly, Path=/, SameSite=Lax)", () => {
    expect(serializeCookie({ name: "podkit_session", value: "tok" })).toBe(
      "podkit_session=tok; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("percent-encodes the value", () => {
    expect(serializeCookie({ name: "x", value: "a b;c" })).toContain("x=a%20b%3Bc");
  });

  it("emits Max-Age when provided (used with value='' to clear)", () => {
    const c = serializeCookie({ name: "podkit_session", value: "", maxAge: 0 });
    expect(c).toContain("podkit_session=");
    expect(c).toContain("Max-Age=0");
  });

  it("honors httpOnly:false and a custom path / sameSite", () => {
    const c = serializeCookie({
      name: "x",
      value: "y",
      httpOnly: false,
      path: "/sub",
      sameSite: "Strict",
    });
    expect(c).not.toContain("HttpOnly");
    expect(c).toContain("Path=/sub");
    expect(c).toContain("SameSite=Strict");
  });

  it("adds Secure when explicitly requested", () => {
    expect(serializeCookie({ name: "x", value: "y", secure: true })).toContain("Secure");
  });
});
