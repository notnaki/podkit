import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../src/client.ts";
import { applyMigrations } from "../src/migrations/apply.ts";
import type { DbClient } from "../src/client.ts";

// Exercises the DATABASE_URL / connectionString (node-postgres) path. Uses a
// throwaway Postgres container, mirroring the cloud-store test harness.
const containerName = `podkit-dbclient-${randomBytes(4).toString("hex")}`;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

let connectionString: string;
const clients: DbClient[] = [];

beforeAll(async () => {
  docker([
    "run", "-d", "--rm", "--label", "podkit.test=1", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=pk", "-p", "0:5432", "postgres:16-alpine",
  ]);
  const portLine = docker(["port", containerName, "5432"]);
  const hostPort = portLine.split("\n")[0].split(":").pop();
  connectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;

  // Poll for readiness.
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    const probe = createDbClient({ connectionString });
    try {
      await probe.raw("select 1");
      ready = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await probe.close();
    }
  }
  if (!ready) throw new Error("postgres did not become ready");
}, 60000);

afterAll(async () => {
  for (const c of clients) {
    try { await c.close(); } catch { /* best-effort */ }
  }
  try { docker(["rm", "-f", containerName]); } catch { /* best-effort */ }
});

describe("createDbClient — Postgres (connectionString) path", () => {
  it("persists data across separate clients on the same connection string", async () => {
    const a = createDbClient({ connectionString });
    clients.push(a);
    await a.raw("create table if not exists shared (id int primary key, name text)");
    await a.raw("insert into shared (id, name) values ($1, $2)", [1, "alice"]);

    // A second, independent client must SEE the row — pglite (in-memory per
    // instance) would not; real Postgres does.
    const b = createDbClient({ connectionString });
    clients.push(b);
    const rows = (await b.raw("select name from shared where id = $1", [1])) as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("alice");
  });

  it("prefers DATABASE_URL when no explicit connectionString is given", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = connectionString;
    try {
      const c = createDbClient();
      clients.push(c);
      const rows = (await c.raw("select 1 as ok")) as { ok: number }[];
      expect(rows[0].ok).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it("runs migrations against Postgres via applyMigrations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "podkit-mig-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "0000_init.sql"),
      "CREATE TABLE notes_mig (id serial primary key, body text);",
    );
    try {
      const client = createDbClient({ connectionString });
      clients.push(client);
      const first = await applyMigrations({ client, dir });
      expect(first.applied).toEqual(["0000"]);
      await client.raw("insert into notes_mig (body) values ($1)", ["hi"]);
      const rows = (await client.raw("select body from notes_mig")) as { body: string }[];
      expect(rows[0].body).toBe("hi");
      // Idempotent: a second run applies nothing.
      const second = await applyMigrations({ client, dir });
      expect(second.applied).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
