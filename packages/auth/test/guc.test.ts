import { describe, it, expect, afterAll } from "vitest";
import { createDbClient } from "@podkit/db";
import { enableRls, ownedBy } from "@podkit/db";
import { applySessionGuc } from "../src/guc.ts";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const client = createDbClient();

afterAll(async () => {
  await client.close();
});

describe("applySessionGuc → RLS isolation", () => {
  it("sets GUCs so RLS filters rows by user identity", async () => {
    // Create the table with explicit UUIDs to avoid gen_random_uuid() dependency
    await client.raw(
      `CREATE TABLE posts (
        id uuid PRIMARY KEY,
        author_id uuid,
        title text
      )`
    );

    // Insert both rows while still connected as the superuser owner
    await client.raw(
      `INSERT INTO posts (id, author_id, title) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $1, 'Post by A'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $2, 'Post by B')`,
      [USER_A, USER_B]
    );

    // Enable RLS and create the owned_by policy
    await client.raw(enableRls("posts"));
    await client.raw(ownedBy("posts", "author_id"));

    // pglite's superuser (postgres) bypasses RLS even with FORCE ROW LEVEL SECURITY
    // (pglite Wasm limitation). Use SET ROLE to a non-superuser role instead;
    // non-superuser roles ARE subject to RLS normally.
    await client.raw("CREATE ROLE app_user");
    await client.raw("GRANT SELECT ON posts TO app_user");

    // --- User A sees only their row ---
    // Set GUC as superuser first, then switch to the non-superuser role to query
    await applySessionGuc(client, { userId: USER_A, isAgent: false });
    await client.raw("SET ROLE app_user");
    const rowsA = await client.raw("SELECT author_id FROM posts") as Array<{ author_id: string }>;
    await client.raw("RESET ROLE");

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.author_id).toBe(USER_A);

    // --- User B sees only their row ---
    await applySessionGuc(client, { userId: USER_B, isAgent: false });
    await client.raw("SET ROLE app_user");
    const rowsB = await client.raw("SELECT author_id FROM posts") as Array<{ author_id: string }>;
    await client.raw("RESET ROLE");

    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.author_id).toBe(USER_B);
  });

  it("sets podkit.user_id GUC correctly (unit check)", async () => {
    await applySessionGuc(client, { userId: USER_A, isAgent: false });
    const result = await client.raw("SELECT current_setting('podkit.user_id') AS val") as Array<{ val: string }>;
    expect(result[0]!.val).toBe(USER_A);
  });

  it("sets podkit.org_id to empty string when orgId is omitted", async () => {
    await applySessionGuc(client, { userId: USER_A, isAgent: false });
    const result = await client.raw("SELECT current_setting('podkit.org_id') AS val") as Array<{ val: string }>;
    expect(result[0]!.val).toBe("");
  });

  it("sets podkit.org_id when provided", async () => {
    const ORG = "deadbeef-dead-dead-dead-deaddeadbeef";
    await applySessionGuc(client, { userId: USER_A, orgId: ORG, isAgent: false });
    const result = await client.raw("SELECT current_setting('podkit.org_id') AS val") as Array<{ val: string }>;
    expect(result[0]!.val).toBe(ORG);
  });

  it("sets podkit.is_agent to 'true' for agent identity", async () => {
    await applySessionGuc(client, { userId: USER_A, isAgent: true });
    const result = await client.raw("SELECT current_setting('podkit.is_agent') AS val") as Array<{ val: string }>;
    expect(result[0]!.val).toBe("true");
  });

  it("sets podkit.is_agent to 'false' for non-agent identity", async () => {
    await applySessionGuc(client, { userId: USER_A, isAgent: false });
    const result = await client.raw("SELECT current_setting('podkit.is_agent') AS val") as Array<{ val: string }>;
    expect(result[0]!.val).toBe("false");
  });
});
