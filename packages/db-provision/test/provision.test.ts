import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  provisionDatabase,
  dropDatabase,
  createBranchDatabase,
  dropBranchDatabase,
  sanitizeSlug,
} from "../src/index.ts";

const suffix = randomBytes(4).toString("hex");
const containerName = `podkit-prov-${suffix}`;

let adminConnectionString = "";
let provisionedDatabase = "";
// Additional databases (e.g. branches) created during tests, cleaned up below.
const provisionedDatabases: string[] = [];

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

async function waitForReady(connectionString: string): Promise<void> {
  const deadline = Date.now() + 50_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres never became ready: ${String(lastErr)}`);
}

beforeAll(async () => {
  docker([
    "run",
    "-d",
    "--rm",
    "--label",
    "podkit.test=1",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=pk",
    "-p",
    "0:5432",
    "postgres:16-alpine",
  ]);

  // `docker port <name> 5432` prints e.g. "0.0.0.0:54321" (possibly multiple lines).
  const portLine = docker(["port", containerName, "5432"]).split("\n")[0];
  const hostPort = portLine.split(":").pop();
  if (!hostPort) {
    throw new Error(`Could not determine host port from: ${portLine}`);
  }

  adminConnectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;
  await waitForReady(adminConnectionString);
}, 60_000);

afterAll(async () => {
  // Drop branch (and other) databases first; a branch's template may be one of
  // these, but DROP order is independent once sessions are terminated.
  for (const database of provisionedDatabases) {
    try {
      if (adminConnectionString && database) {
        await dropDatabase({ adminConnectionString, database });
      }
    } catch {
      // ignore cleanup errors
    }
  }
  try {
    if (adminConnectionString && provisionedDatabase) {
      await dropDatabase({
        adminConnectionString,
        database: provisionedDatabase,
      });
    }
  } catch {
    // ignore cleanup errors
  }
  try {
    docker(["rm", "-f", containerName]);
  } catch {
    // ignore cleanup errors
  }
}, 60_000);

describe("sanitizeSlug", () => {
  it("lowercases, replaces unsafe chars, and prefixes proj_", () => {
    expect(sanitizeSlug("My App!")).toBe("proj_my_app");
    expect(sanitizeSlug("  foo--bar ")).toBe("proj_foo_bar");
    expect(sanitizeSlug("!!!")).toBe("proj_db");
  });
});

describe("provisionDatabase", () => {
  it(
    "creates a usable database and is idempotent",
    async () => {
      const result = await provisionDatabase({
        adminConnectionString,
        slug: "My App!",
      });
      provisionedDatabase = result.database;

      expect(result.database).toBe("proj_my_app");
      expect(result.connectionString).toContain("/proj_my_app");

      // The returned connection string must point at a working database.
      const client = new Client({ connectionString: result.connectionString });
      await client.connect();
      try {
        const res = await client.query("SELECT 1 AS ok");
        expect(res.rows[0].ok).toBe(1);
      } finally {
        await client.end();
      }

      // Re-provisioning the same slug must not throw (idempotent).
      const again = await provisionDatabase({
        adminConnectionString,
        slug: "My App!",
      });
      expect(again.database).toBe("proj_my_app");
    },
    60_000,
  );

  it(
    "hands out a scoped, non-superuser role — not admin creds",
    async () => {
      const result = await provisionDatabase({
        adminConnectionString,
        slug: "scoped",
      });
      expect(result.role).toBe("proj_scoped_app");

      // The returned creds must NOT be the admin/superuser.
      const url = new URL(result.connectionString);
      expect(url.username).toBe("proj_scoped_app");
      expect(url.username).not.toBe("postgres");

      // The role must lack superuser / createdb / createrole.
      const admin = new Client({ connectionString: adminConnectionString });
      await admin.connect();
      try {
        const r = await admin.query(
          "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
          [result.role],
        );
        expect(r.rows[0]).toMatchObject({
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
        });
      } finally {
        await admin.end();
      }

      // The role can fully operate inside its own database (owns public).
      const own = new Client({ connectionString: result.connectionString });
      await own.connect();
      try {
        await own.query("CREATE TABLE items (id int primary key, name text)");
        await own.query("INSERT INTO items VALUES (1, 'a')");
        const sel = await own.query("SELECT name FROM items WHERE id = 1");
        expect(sel.rows[0].name).toBe("a");
      } finally {
        await own.end();
      }
    },
    60_000,
  );

  it(
    "a project role cannot connect to another project's database",
    async () => {
      const a = await provisionDatabase({ adminConnectionString, slug: "tenant-a" });
      const b = await provisionDatabase({ adminConnectionString, slug: "tenant-b" });

      // Take tenant A's credentials but point them at tenant B's database.
      const crossUrl = new URL(a.connectionString);
      crossUrl.pathname = `/${b.database}`;

      const intruder = new Client({ connectionString: crossUrl.toString() });
      let failed = false;
      try {
        await intruder.connect();
        await intruder.end();
      } catch {
        failed = true;
        await intruder.end().catch(() => {});
      }
      expect(failed).toBe(true);
    },
    60_000,
  );
});

describe("createBranchDatabase", () => {
  it(
    "creates an isolated branch from a base database",
    async () => {
      // 1. Provision base DB
      const baseResult = await provisionDatabase({
        adminConnectionString,
        slug: "branch-test-base",
      });
      const baseDb = baseResult.database;
      provisionedDatabases.push(baseDb);

      // 2. Write a test row to base using base role
      const baseClient = new Client({
        connectionString: baseResult.connectionString,
      });
      await baseClient.connect();
      await baseClient.query(
        "CREATE TABLE test (id serial PRIMARY KEY, msg text)",
      );
      await baseClient.query("INSERT INTO test (msg) VALUES ('base-row')");
      await baseClient.end();

      // 3. Create branch from base
      const branchResult = await createBranchDatabase({
        adminConnectionString,
        baseSlug: "branch-test-base",
        branchName: "feature_x",
      });
      const branchDb = branchResult.database;
      provisionedDatabases.push(branchDb);

      // The branch gets its own scoped, non-admin role + connection string.
      expect(branchResult.database).toBe("proj_branch_test_base_feature_x");
      expect(branchResult.role).toBe("proj_branch_test_base_feature_x_app");
      const branchUrl = new URL(branchResult.connectionString);
      expect(branchUrl.username).toBe("proj_branch_test_base_feature_x_app");
      expect(branchUrl.username).not.toBe("postgres");

      // 4. Branch should see the copied row
      const branchClient = new Client({
        connectionString: branchResult.connectionString,
      });
      await branchClient.connect();
      const copyCheck = await branchClient.query(
        "SELECT msg FROM test WHERE msg = 'base-row'",
      );
      expect(copyCheck.rows.length).toBe(1);

      // 5. Write to branch, verify base is unaffected
      await branchClient.query("INSERT INTO test (msg) VALUES ('branch-row')");
      await branchClient.end();

      // 6. Read base again: should only have base-row
      const baseCheck = new Client({
        connectionString: baseResult.connectionString,
      });
      await baseCheck.connect();
      const baseRows = await baseCheck.query("SELECT msg FROM test ORDER BY id");
      expect(baseRows.rows.map((r) => r.msg)).toEqual(["base-row"]);
      await baseCheck.end();

      // 7. Read branch: should have both
      const branchRecheck = new Client({
        connectionString: branchResult.connectionString,
      });
      await branchRecheck.connect();
      const branchRows = await branchRecheck.query(
        "SELECT msg FROM test ORDER BY id",
      );
      expect(branchRows.rows.map((r) => r.msg)).toEqual([
        "base-row",
        "branch-row",
      ]);
      await branchRecheck.end();

      // 8. Drop branch
      await dropBranchDatabase({
        adminConnectionString,
        database: branchDb,
        role: branchResult.role,
      });

      // 9. Base should still exist and be readable
      const baseStillWorks = new Client({
        connectionString: baseResult.connectionString,
      });
      await baseStillWorks.connect();
      const stillThere = await baseStillWorks.query("SELECT count(*) FROM test");
      expect(parseInt(stillThere.rows[0].count)).toBe(1);
      await baseStillWorks.end();
    },
    120_000,
  );

  it("rejects invalid branch names without provisioning", async () => {
    await expect(
      createBranchDatabase({
        adminConnectionString,
        baseSlug: "branch-test-base",
        branchName: "Bad-Name",
      }),
    ).rejects.toThrow(/invalid branch name/);
    await expect(
      createBranchDatabase({
        adminConnectionString,
        baseSlug: "branch-test-base",
        branchName: "_leading",
      }),
    ).rejects.toThrow(/invalid branch name/);
  });
});
