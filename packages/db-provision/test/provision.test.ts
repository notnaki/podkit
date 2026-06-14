import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  provisionDatabase,
  dropDatabase,
  sanitizeSlug,
} from "../src/index.ts";

const suffix = randomBytes(4).toString("hex");
const containerName = `podkit-prov-${suffix}`;

let adminConnectionString = "";
let provisionedDatabase = "";

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
