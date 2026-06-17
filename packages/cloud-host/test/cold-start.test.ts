import { describe, it, expect } from "vitest";
import { shouldReap } from "../src/host.ts";

// The scale-to-zero idle policy (pure decision used by the reaper). The wake +
// container lifecycle is Docker-gated and exercised by the e2e suites; here we
// pin the policy that decides when a route is reaped.
describe("shouldReap — scale-to-zero idle policy", () => {
  const idle = 15 * 60_000; // 15 min

  it("does not reap before the idle window elapses", () => {
    expect(shouldReap(1_000, 1_000 + idle - 1, idle)).toBe(false);
  });

  it("reaps once idle for at least the window", () => {
    expect(shouldReap(1_000, 1_000 + idle, idle)).toBe(true);
    expect(shouldReap(1_000, 1_000 + idle + 5_000, idle)).toBe(true);
  });

  it("is disabled (never reaps) when idleMs <= 0", () => {
    expect(shouldReap(0, 1e12, 0)).toBe(false);
    expect(shouldReap(0, 1e12, -1)).toBe(false);
  });
});
