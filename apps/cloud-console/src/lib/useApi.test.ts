import { describe, it, expect } from "vitest";
import { relativeTime, resolveStatus } from "./useApi.ts";

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

describe("resolveStatus", () => {
  it("prefers the live SSE status over the snapshot", () => {
    // snapshot says running, but the live stream says it went to sleep
    expect(resolveStatus("sleeping", { status: "running", version: "v1" })).toEqual({
      cls: "status status-none",
      label: "Sleeping",
    });
  });

  it("maps live waking to the building pill", () => {
    expect(resolveStatus("waking", { status: "running", version: "v1" })).toEqual({
      cls: "status status-building",
      label: "Waking",
    });
  });

  it("maps live ready to the ready pill", () => {
    expect(resolveStatus("ready", { status: "running", version: "v1" }).label).toBe("Ready");
  });

  it("falls back to the snapshot when there is no live status", () => {
    expect(resolveStatus(null, { status: "running", version: "v1" }).label).toBe("Ready");
    expect(resolveStatus(null, { sleeping: true, status: "running", version: "v1" }).label).toBe("Sleeping");
  });

  it("reports no deployment when there is no version", () => {
    expect(resolveStatus(null, {})).toEqual({ cls: "status status-none", label: "No deployment" });
  });

  it("surfaces a non-running snapshot status as an error pill", () => {
    expect(resolveStatus(null, { status: "exited", version: "v1" })).toEqual({
      cls: "status status-error",
      label: "exited",
    });
  });
});
