import { describe, it, expect } from "vitest";
import { requireApiKey } from "../src/apikey.ts";

describe("requireApiKey", () => {
  it("returns true when the x-podkit-key header matches the expected key", () => {
    expect(requireApiKey({ "x-podkit-key": "secret" }, "secret")).toBe(true);
  });

  it("returns false when the provided key does not match", () => {
    expect(requireApiKey({ "x-podkit-key": "wrong" }, "secret")).toBe(false);
  });

  it("returns false when the header is missing", () => {
    expect(requireApiKey({}, "secret")).toBe(false);
  });

  it("returns false when expected is undefined", () => {
    expect(requireApiKey({ "x-podkit-key": "secret" }, undefined)).toBe(false);
  });

  it("returns false when expected is an empty string", () => {
    expect(requireApiKey({ "x-podkit-key": "secret" }, "")).toBe(false);
  });

  it("accepts the header as a string array and uses the first element", () => {
    expect(requireApiKey({ "x-podkit-key": ["secret"] }, "secret")).toBe(true);
  });

  it("returns false when the header is an empty array", () => {
    expect(requireApiKey({ "x-podkit-key": [] }, "secret")).toBe(false);
  });

  it("returns false on length mismatch without throwing", () => {
    expect(requireApiKey({ "x-podkit-key": "short" }, "muchlongerkey")).toBe(false);
  });

  it("returns false when the header value is undefined", () => {
    expect(requireApiKey({ "x-podkit-key": undefined }, "secret")).toBe(false);
  });
});
