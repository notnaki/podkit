import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../src/client.ts";
import type { DbClient } from "../src/client.ts";
import { pullSchema } from "../src/pull.ts";

let client: DbClient | undefined;
const outDir = mkdtempSync(join(tmpdir(), "podkit-pull-"));

afterAll(async () => {
  if (client) {
    await client.close();
  }
  rmSync(outDir, { recursive: true, force: true });
});

describe("pullSchema", () => {
  it("captures out-of-band schema changes into a migration file", async () => {
    client = createDbClient();

    // Create a table out-of-band (simulating a human editing the DB)
    await client.raw("CREATE TABLE widget (id integer NOT NULL, label text)");

    const result = await pullSchema({
      client,
      outDir,
      timestamp: 1700000000000,
    });

    // tables list includes "widget"
    expect(result.tables).toContain("widget");

    // migration file was written
    expect(existsSync(result.migrationFile)).toBe(true);

    // file content captures DDL with CREATE TABLE, table name, and columns
    const content = readFileSync(result.migrationFile, "utf-8");
    expect(content).toContain("CREATE TABLE");
    expect(content).toContain("widget");
    expect(content).toContain("id");
    expect(content).toContain("label");
  });
});
