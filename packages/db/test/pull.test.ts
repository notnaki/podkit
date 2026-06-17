import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDbClient } from "../src/client.ts";
import type { DbClient } from "../src/client.ts";
import { pullSchema, generateTsSchema } from "../src/pull.ts";

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

    const schemaFile = join(outDir, "schema.ts");
    const result = await pullSchema({
      client,
      outDir,
      timestamp: 1700000000000,
      schemaFile,
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

    // a regenerated drizzle schema.ts was also written
    expect(result.schemaFile).toBe(schemaFile);
    const ts = readFileSync(schemaFile, "utf-8");
    expect(ts).toContain('from "@podkit/db"');
    expect(ts).toContain('export const widget = pgTable("widget"');
    expect(ts).toContain('id: integer("id").notNull()');
    expect(ts).toContain('label: text("label")');
  });
});

describe("generateTsSchema", () => {
  it("maps pg types to @podkit/db helpers and imports only what's used", () => {
    const ts = generateTsSchema([
      {
        name: "users",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, isPk: true },
          { name: "email", dataType: "text", nullable: false, isPk: false },
          { name: "age", dataType: "integer", nullable: true, isPk: false },
          { name: "active", dataType: "boolean", nullable: false, isPk: false },
          { name: "created_at", dataType: "timestamp with time zone", nullable: true, isPk: false },
          { name: "meta", dataType: "jsonb", nullable: true, isPk: false },
        ],
      },
    ]);
    expect(ts).toContain('import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "@podkit/db";');
    expect(ts).toContain('id: uuid("id").primaryKey(),');
    expect(ts).toContain('email: text("email").notNull(),');
    expect(ts).toContain('age: integer("age"),');
    expect(ts).toContain('created_at: timestamp("created_at"),');
    expect(ts).toContain('meta: jsonb("meta"),');
  });

  it("falls back to text() with a TODO for unmapped types", () => {
    const ts = generateTsSchema([
      { name: "t", columns: [{ name: "loc", dataType: "point", nullable: true, isPk: false }] },
    ]);
    expect(ts).toContain('loc: text("loc"), // TODO: point mapped to text()');
  });
});
