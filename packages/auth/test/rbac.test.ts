import { describe, it, expect } from "vitest";
import { roleAtLeast, can } from "../src/rbac.ts";
import type { Membership } from "../src/rbac.ts";

describe("roleAtLeast", () => {
  it("returns true when role rank is higher than min", () => {
    expect(roleAtLeast("admin", "member")).toBe(true);
  });

  it("returns false when role rank is lower than min", () => {
    expect(roleAtLeast("viewer", "admin")).toBe(false);
  });

  it("returns true when role equals min (same rank)", () => {
    expect(roleAtLeast("owner", "owner")).toBe(true);
  });
});

describe("can", () => {
  it("viewer can read", () => {
    const m: Membership = { userId: "u", orgId: "o", role: "viewer" };
    expect(can(m, "read")).toBe(true);
  });

  it("viewer cannot write", () => {
    const m: Membership = { userId: "u", orgId: "o", role: "viewer" };
    expect(can(m, "write")).toBe(false);
  });

  it("member can write", () => {
    const m: Membership = { userId: "u", orgId: "o", role: "member" };
    expect(can(m, "write")).toBe(true);
  });

  it("member cannot manage", () => {
    const m: Membership = { userId: "u", orgId: "o", role: "member" };
    expect(can(m, "manage")).toBe(false);
  });

  it("admin can manage", () => {
    const m: Membership = { userId: "u", orgId: "o", role: "admin" };
    expect(can(m, "manage")).toBe(true);
  });
});
