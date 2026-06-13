import { describe, it, expect } from "vitest";
import {
  enableRls,
  ownedBy,
  inOrg,
  isAgent,
  customPolicy,
} from "../src/rls/policy.ts";

describe("RLS policy DSL", () => {
  it("enableRls generates ALTER TABLE ... ENABLE ROW LEVEL SECURITY", () => {
    expect(enableRls("posts")).toBe(
      `ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;`
    );
  });

  it("ownedBy generates a policy checking podkit.user_id", () => {
    expect(ownedBy("posts", "author_id")).toBe(
      `CREATE POLICY "posts_owned_by" ON "posts" USING ("author_id" = current_setting('podkit.user_id')::uuid);`
    );
  });

  it("inOrg generates a policy checking podkit.org_id", () => {
    expect(inOrg("posts", "org_id")).toBe(
      `CREATE POLICY "posts_in_org" ON "posts" USING ("org_id" = current_setting('podkit.org_id')::uuid);`
    );
  });

  it("isAgent generates a policy checking podkit.is_agent", () => {
    expect(isAgent("posts")).toBe(
      `CREATE POLICY "posts_is_agent" ON "posts" USING (current_setting('podkit.is_agent')::boolean = true);`
    );
  });

  it("customPolicy passes raw using expression verbatim", () => {
    expect(
      customPolicy(
        "posts",
        "complex_access",
        `author_id = current_setting('podkit.user_id')::uuid OR current_setting('podkit.is_agent')::boolean`
      )
    ).toBe(
      `CREATE POLICY "complex_access" ON "posts" USING (author_id = current_setting('podkit.user_id')::uuid OR current_setting('podkit.is_agent')::boolean);`
    );
  });
});
