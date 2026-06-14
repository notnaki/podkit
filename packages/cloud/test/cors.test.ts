import { describe, it, expect } from "vitest";
import { parseCorsOrigins, resolveCorsHeader } from "../src/cors.ts";

describe("parseCorsOrigins", () => {
  it("returns null when env var is undefined", () => {
    expect(parseCorsOrigins(undefined)).toBeNull();
  });

  it("parses comma-separated origins", () => {
    const result = parseCorsOrigins(
      "https://example.com,https://app.example.com",
    );
    expect(result).toEqual(["https://example.com", "https://app.example.com"]);
  });

  it("trims whitespace from origins", () => {
    const result = parseCorsOrigins(
      " https://example.com , https://app.example.com ",
    );
    expect(result).toEqual(["https://example.com", "https://app.example.com"]);
  });

  it("handles empty string", () => {
    expect(parseCorsOrigins("")).toEqual([]);
  });

  it("filters out empty segments", () => {
    const result = parseCorsOrigins(
      "https://example.com,,https://app.example.com",
    );
    expect(result).toEqual(["https://example.com", "https://app.example.com"]);
  });
});

describe("resolveCorsHeader", () => {
  it("returns wildcard when allowedOrigins is null", () => {
    expect(resolveCorsHeader("https://any-origin.com", null)).toEqual({
      origin: "*",
      vary: false,
    });
  });

  it("reflects matching origin and sets Vary header", () => {
    expect(
      resolveCorsHeader("https://example.com", ["https://example.com"]),
    ).toEqual({ origin: "https://example.com", vary: true });
  });

  it("returns null origin for non-matching origin", () => {
    expect(
      resolveCorsHeader("https://evil.com", ["https://example.com"]),
    ).toEqual({ origin: null, vary: true });
  });

  it("returns null origin when request has no Origin header", () => {
    expect(resolveCorsHeader(undefined, ["https://example.com"])).toEqual({
      origin: null,
      vary: true,
    });
  });

  it("handles multiple allowed origins", () => {
    const allowed = ["https://example.com", "https://app.example.com"];
    expect(resolveCorsHeader("https://app.example.com", allowed)).toEqual({
      origin: "https://app.example.com",
      vary: true,
    });
    expect(resolveCorsHeader("https://evil.com", allowed)).toEqual({
      origin: null,
      vary: true,
    });
  });

  it("performs case-sensitive origin matching", () => {
    expect(
      resolveCorsHeader("HTTPS://EXAMPLE.COM", ["https://example.com"]),
    ).toEqual({ origin: null, vary: true });
  });

  it("returns null origin for an empty allowlist", () => {
    expect(resolveCorsHeader("https://example.com", [])).toEqual({
      origin: null,
      vary: true,
    });
  });
});
