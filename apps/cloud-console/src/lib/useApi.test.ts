import { describe, it, expect } from "vitest";
import { relativeTime } from "./useApi.ts";

describe("relativeTime", () => {
  const now = 1_000_000_000_000;

  it("formats seconds", () => {
    expect(relativeTime(now - 5_000, now)).toBe("5s ago");
  });

  it("formats minutes", () => {
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
  });

  it("formats hours", () => {
    expect(relativeTime(now - 7_200_000, now)).toBe("2h ago");
  });

  it("formats days", () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("clamps future timestamps to 0s", () => {
    expect(relativeTime(now + 5_000, now)).toBe("0s ago");
  });
});
