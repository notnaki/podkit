import { describe, it, expect } from "vitest";
import { shouldReap, deadRouteKeys } from "../src/host.ts";

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

// The liveness reconcile decision: which routed containers have died out of
// band. The docker call + state mutation are Docker-gated; here we pin the pure
// set-difference that drives "show it as sleeping without waiting for a request".
describe("deadRouteKeys — liveness reconcile", () => {
  it("returns routes whose container is not running", () => {
    const routes = new Map([
      ["live", "podkit-app-live-aaa"],
      ["dead", "podkit-app-dead-bbb"],
    ]);
    const running = new Set(["podkit-app-live-aaa", "infra-controlplane-1"]);
    expect(deadRouteKeys(routes, running)).toEqual(["dead"]);
  });

  it("never flags previews (keys with --), which don't cold-start", () => {
    const routes = new Map([["app--feature", "podkit-app-app--feature-ccc"]]);
    expect(deadRouteKeys(routes, new Set())).toEqual([]);
  });

  it("is empty when everything is running", () => {
    const routes = new Map([["a", "n-a"], ["b", "n-b"]]);
    expect(deadRouteKeys(routes, new Set(["n-a", "n-b"]))).toEqual([]);
  });
});
