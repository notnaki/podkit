import { describe, it, expect } from "vitest";
import { decideProjectAccess } from "../src/host.ts";

// ponytail: pure helper tests; upgrade to a live-DB integration test if
// acceptInvite idempotency or isMember need DB-level coverage (see store.test.ts).

describe("decideProjectAccess", () => {
  it("grants access to the project owner", () => {
    expect(decideProjectAccess("alice", "alice", null)).toBe("ok");
  });

  it("grants access to any project member (regardless of role)", () => {
    expect(decideProjectAccess("bob", "alice", "member")).toBe("ok");
    expect(decideProjectAccess("bob", "alice", "admin")).toBe("ok");
    expect(decideProjectAccess("bob", "alice", "viewer")).toBe("ok");
  });

  it("denies access when the account is neither owner nor member", () => {
    expect(decideProjectAccess("carol", "alice", null)).toBe("forbidden");
  });

  it("owner wins even if the memberRole is unexpectedly also set", () => {
    // Owner is owner regardless of what the DB says about membership.
    expect(decideProjectAccess("alice", "alice", "member")).toBe("ok");
  });
});
