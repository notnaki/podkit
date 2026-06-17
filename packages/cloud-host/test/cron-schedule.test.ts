import { describe, it, expect } from "vitest";
import { isDue, isValidSchedule } from "../src/cron-schedule.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
// Fixed clock so the tests never depend on the real wall clock.
const NOW = 1_700_000_000_000;

describe("isDue", () => {
  describe("@hourly", () => {
    it("is due when never run", () => {
      expect(isDue("@hourly", null, NOW)).toBe(true);
    });
    it("is due when >= 1 hour has passed", () => {
      expect(isDue("@hourly", NOW - HOUR, NOW)).toBe(true);
    });
    it("is not due when < 1 hour has passed", () => {
      expect(isDue("@hourly", NOW - HOUR + 1000, NOW)).toBe(false);
    });
  });

  describe("@daily", () => {
    it("is due when never run", () => {
      expect(isDue("@daily", null, NOW)).toBe(true);
    });
    it("is due when >= 24 hours have passed", () => {
      expect(isDue("@daily", NOW - 24 * HOUR, NOW)).toBe(true);
    });
    it("is not due when < 24 hours have passed", () => {
      expect(isDue("@daily", NOW - 24 * HOUR + 1000, NOW)).toBe(false);
    });
  });

  describe("@every <N>m / <N>h", () => {
    it("fires every N minutes", () => {
      expect(isDue("@every 5m", NOW - 5 * MIN, NOW)).toBe(true);
      expect(isDue("@every 5m", NOW - 4 * MIN, NOW)).toBe(false);
      expect(isDue("@every 1m", NOW - MIN, NOW)).toBe(true);
    });
    it("fires every N hours", () => {
      expect(isDue("@every 2h", NOW - 2 * HOUR, NOW)).toBe(true);
      expect(isDue("@every 2h", NOW - 2 * HOUR + 1000, NOW)).toBe(false);
    });
  });

  describe("*/<N> (every N minutes)", () => {
    it("is due when never run and when >= N minutes have passed", () => {
      expect(isDue("*/15", null, NOW)).toBe(true);
      expect(isDue("*/15", NOW - 15 * MIN, NOW)).toBe(true);
      expect(isDue("*/15", NOW - 14 * MIN, NOW)).toBe(false);
      expect(isDue("*/1", NOW - MIN, NOW)).toBe(true);
    });
  });

  describe("unknown format", () => {
    it("is never due", () => {
      expect(isDue("not-a-schedule", null, NOW)).toBe(false);
      expect(isDue("0 9 * * *", null, NOW)).toBe(false);
      expect(isDue("@every", null, NOW)).toBe(false);
      expect(isDue("@every 0m", null, NOW)).toBe(false);
      expect(isDue("*/0", null, NOW)).toBe(false);
    });
  });
});

describe("isValidSchedule", () => {
  it("accepts known forms", () => {
    for (const s of ["@hourly", "@daily", "@every 5m", "@every 2h", "*/15", "*/1"]) {
      expect(isValidSchedule(s)).toBe(true);
    }
  });
  it("rejects unknown forms", () => {
    for (const s of ["0 9 * * *", "@every 0m", "*/0", "", "@weekly"]) {
      expect(isValidSchedule(s)).toBe(false);
    }
  });
});
