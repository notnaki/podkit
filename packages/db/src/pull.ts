import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "./client.ts";
import { migrationFilename } from "./migrations/files.ts";

// NOTE: Regenerating the TypeScript schema.ts from the introspection result
// is DEFERRED to a later phase.

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

interface TableRow {
  table_name: string;
}

/**
 * Captures out-of-band schema changes back into a versioned migration file
 * by introspecting via Postgres information_schema (works on pglite).
 */
export async function pullSchema(opts: {
  client: DbClient;
  outDir: string;
  timestamp: number;
}): Promise<{ migrationFile: string; tables: string[] }> {
  const { client, outDir, timestamp } = opts;

  // Query user tables in the public schema, excluding podkit internal table
  const tableRows = (await client.raw(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_podkit_migrations' ORDER BY table_name`
  )) as TableRow[];

  const tables = tableRows.map((r) => r.table_name);

  // Reconstruct CREATE TABLE statements for each table
  const statements: string[] = [];

  for (const tableName of tables) {
    const columnRows = (await client.raw(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [tableName]
    )) as ColumnRow[];

    const columnDefs = columnRows.map((col) => {
      const nullable = col.is_nullable === "NO" ? " NOT NULL" : "";
      return `  "${col.column_name}" ${col.data_type}${nullable}`;
    });

    const statement =
      `CREATE TABLE "${tableName}" (\n` + columnDefs.join(",\n") + `\n);`;

    statements.push(statement);
  }

  const sql = statements.join("\n\n");

  // Ensure output directory exists
  mkdirSync(outDir, { recursive: true });

  const filename = migrationFilename(timestamp, "pull");
  const migrationFile = join(outDir, filename);

  writeFileSync(migrationFile, sql, "utf-8");

  return { migrationFile, tables };
}
