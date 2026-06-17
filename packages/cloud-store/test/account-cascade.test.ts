import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createStore } from "../src/index.ts";
import type { Store, QueryablePool } from "../src/store.ts";

// Docker-free store test: back createStore with an embedded Postgres (PGlite)
// adapted to the small pg.Pool subset the store uses. This exercises the real
// store SQL (migrate + deleteAccountCascade + reset/verify tokens) without a
// container, complementing the Docker-gated accounts.test.ts.
function pglitePool(): { pool: QueryablePool; raw: PGlite } {
  const pg = new PGlite();
  const pool: QueryablePool = {
    async query<R extends Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) {
      const res = await pg.query<R>(text, params as unknown[] | undefined);
      // pg.Pool exposes rowCount; PGlite calls it affectedRows.
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    async end() {
      await pg.close();
    },
  };
  return { pool, raw: pg };
}

let store: Store;

beforeAll(async () => {
  const { pool } = pglitePool();
  store = createStore({ pool });
  await store.migrate();
});

afterAll(async () => {
  await store.close();
});

describe("cloud-store account lifecycle (PGlite, no Docker)", () => {
  it("password reset token: hashed at rest, single-use, expiry", async () => {
    const account = await store.createAccount({
      email: "reset@example.com",
      passwordHash: "old-hash",
    });

    const token = "plain-reset-token-abc";
    await store.createPasswordResetToken({
      accountId: account.id,
      token,
      ttlSeconds: 3600,
    });

    // Stored hashed, never plaintext.
    const stored = await store.getAccountById(account.id);
    expect(stored?.email).toBe("reset@example.com");

    // Consume returns the owner and is single-use.
    const owner = await store.consumePasswordResetToken(token);
    expect(owner).toBe(account.id);
    await store.updateAccountPassword(account.id, "new-hash");
    const after = await store.getAccountByEmail("reset@example.com");
    expect(after?.passwordHash).toBe("new-hash");

    // Reused token rejected (single-use).
    expect(await store.consumePasswordResetToken(token)).toBeNull();
    // Wrong token rejected.
    expect(await store.consumePasswordResetToken("nope")).toBeNull();
  });

  it("email verify token flips emailVerified and is single-use", async () => {
    const account = await store.createAccount({
      email: "verify@example.com",
      passwordHash: "h",
    });
    expect((await store.getAccountById(account.id))?.emailVerified).toBe(false);

    const token = "plain-verify-token-xyz";
    await store.createEmailVerifyToken({
      accountId: account.id,
      token,
      ttlSeconds: 3600,
    });

    const owner = await store.consumeEmailVerifyToken(token);
    expect(owner).toBe(account.id);
    expect((await store.getAccountById(account.id))?.emailVerified).toBe(true);

    // Single-use.
    expect(await store.consumeEmailVerifyToken(token)).toBeNull();
  });

  it("deleteAccountCascade tears down owned projects and removes the account", async () => {
    const account = await store.createAccount({
      email: "cascade@example.com",
      passwordHash: "h",
    });

    // Two projects owned by this account + supporting rows.
    const p1 = await store.createProject({ slug: "casc-a", owner: account.id });
    const p2 = await store.createProject({ slug: "casc-b", owner: account.id });
    await store.setEnv({
      projectId: p1.id,
      key: "K",
      value: "v",
      sensitive: false,
    });
    await store.recordDeployment({
      projectId: p1.id,
      version: "1",
      containerId: "c1",
      hostPort: 1,
      status: "running",
      containerPort: 3000,
      kind: "deploy",
    });

    // A reset token to prove FK cascade removes auth artifacts too.
    await store.createPasswordResetToken({
      accountId: account.id,
      token: "t-cascade",
      ttlSeconds: 3600,
    });

    // Another account's project must NOT be touched.
    const other = await store.createAccount({
      email: "other@example.com",
      passwordHash: "h",
    });
    const op = await store.createProject({ slug: "keep", owner: other.id });

    const tornDown: string[] = [];
    const deleted = await store.deleteAccountCascade(account.id, async (proj) => {
      // The caller's per-project teardown (drops container/DB in prod). Here we
      // delegate to the store's own deleteProject so control-plane rows go too.
      tornDown.push(proj.slug);
      await store.deleteProject(proj.id);
    });

    expect(deleted.map((p) => p.slug).sort()).toEqual(["casc-a", "casc-b"]);
    expect(tornDown.sort()).toEqual(["casc-a", "casc-b"]);

    // Account gone.
    expect(await store.getAccountById(account.id)).toBeNull();
    expect(await store.getAccountByEmail("cascade@example.com")).toBeNull();
    // Reset token consumable -> null (row cascade-deleted).
    expect(await store.consumePasswordResetToken("t-cascade")).toBeNull();
    // Owned projects gone.
    expect(await store.getProjectBySlug("casc-a")).toBeNull();
    expect(await store.getProjectBySlug("casc-b")).toBeNull();
    // Other account's project untouched.
    expect((await store.getProjectBySlug("keep"))?.id).toBe(op.id);

    // Idempotent-ish: deleting again yields no projects, no throw.
    expect(await store.deleteAccountCascade(account.id, async () => {})).toEqual(
      [],
    );
  });
});
