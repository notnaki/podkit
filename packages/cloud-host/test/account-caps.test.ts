import { describe, expect, it } from "vitest";

import { checkAccountCaps, type AccountCaps } from "../src/account-caps.ts";

const caps = (over: Partial<AccountCaps> = {}): AccountCaps => ({
  maxMemoryMb: 0,
  maxContainers: 0,
  perContainerMemoryMb: 512,
  ...over,
});

describe("checkAccountCaps", () => {
  it("passes when both caps are unlimited (0)", () => {
    expect(checkAccountCaps(caps(), 999).ok).toBe(true);
  });

  describe("container-count cap", () => {
    it("passes when starting one more stays at/under the cap", () => {
      // cap 3, currently 2 active -> the 3rd is allowed.
      expect(checkAccountCaps(caps({ maxContainers: 3 }), 2).ok).toBe(true);
    });

    it("rejects when starting one more would exceed the cap", () => {
      // cap 3, currently 3 active -> a 4th is over.
      const d = checkAccountCaps(caps({ maxContainers: 3 }), 3);
      expect(d.ok).toBe(false);
      if (d.ok) throw new Error("expected rejection");
      expect(d.status).toBe(429);
      expect(d.code).toBe("E_QUOTA_CONTAINERS");
      expect(d.hint).toContain("PODKIT_MAX_CONTAINERS_PER_ACCOUNT");
    });
  });

  describe("aggregate memory cap", () => {
    it("passes when projected memory stays at/under the cap", () => {
      // 1024MB cap, 512MB each, 1 active -> projected 2*512=1024 == cap, allowed.
      expect(
        checkAccountCaps(caps({ maxMemoryMb: 1024 }), 1).ok,
      ).toBe(true);
    });

    it("rejects when projected memory would exceed the cap", () => {
      // 1024MB cap, 512MB each, 2 active -> projected 3*512=1536 > 1024.
      const d = checkAccountCaps(caps({ maxMemoryMb: 1024 }), 2);
      expect(d.ok).toBe(false);
      if (d.ok) throw new Error("expected rejection");
      expect(d.status).toBe(429);
      expect(d.code).toBe("E_QUOTA_MEMORY");
      expect(d.message).toContain("1024MB");
      expect(d.hint).toContain("PODKIT_MAX_MEMORY_MB_PER_ACCOUNT");
    });

    it("rejects the very first container when the cap is below one container", () => {
      // 256MB cap but each container needs 512MB -> even the first is over.
      const d = checkAccountCaps(caps({ maxMemoryMb: 256 }), 0);
      expect(d.ok).toBe(false);
    });
  });

  it("enforces the tighter of the two caps (container cap wins here)", () => {
    // Memory would allow it (projected 1024 <= 4096) but the container cap (1) does not.
    const d = checkAccountCaps(
      caps({ maxMemoryMb: 4096, maxContainers: 1 }),
      1,
    );
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("expected rejection");
    expect(d.code).toBe("E_QUOTA_CONTAINERS");
  });
});
