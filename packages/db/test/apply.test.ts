import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../src/client.ts";
import type { DbClient } from "../src/client.ts";
import { applyMigrations } from "../src/migrations/apply.ts";

const dir = mkdtempSync(join(tmpdir(), "podkit-apply-"));
const client: DbClient = createDbClient();

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await client.close();
});

// Write two raw .sql fixture files
writeFileSync(join(dir, "0000000000001_a.sql"), "CREATE TABLE a (id int);");
writeFileSync(join(dir, "0000000000002_b.sql"), "CREATE TABLE b (id int);");

describe("applyMigrations", () => {
  it("applies all pending migrations on first run", async () => {
    const result = await applyMigrations({ client, dir });

    expect(result.applied).toEqual(["0000000000001", "0000000000002"]);

    // Both tables should exist and be queryable
    const rowsA = await client.raw("SELECT * FROM a");
    expect(rowsA).toEqual([]);

    const rowsB = await client.raw("SELECT * FROM b");
    expect(rowsB).toEqual([]);
  });

  it("is idempotent — nothing re-applied on second run", async () => {
    const result = await applyMigrations({ client, dir });

    expect(result.applied).toEqual([]);
  });
});
