import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "./client.ts";
import { migrationFilename } from "./migrations/files.ts";

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

interface TableRow {
  table_name: string;
}

interface PkRow {
  table_name: string;
  column_name: string;
}

interface IntrospectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPk: boolean;
}

interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
}

// Postgres information_schema data_type -> the @podkit/db (drizzle) column helper.
// ponytail: covers the helpers @podkit/db re-exports; unmapped types fall back to
// text() with a TODO so the generated schema still compiles — extend as needed.
const TYPE_MAP: Record<string, string> = {
  uuid: "uuid",
  text: "text",
  "character varying": "text",
  "character": "text",
  integer: "integer",
  bigint: "integer",
  smallint: "integer",
  boolean: "boolean",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  json: "jsonb",
  jsonb: "jsonb",
};

function helperFor(dataType: string): { helper: string; fallback: boolean } {
  const h = TYPE_MAP[dataType];
  return h ? { helper: h, fallback: false } : { helper: "text", fallback: true };
}

/**
 * Generate a drizzle `schema.ts` (TypeScript, importing from "@podkit/db") from
 * an introspected table list. Pure + deterministic so it is easy to test.
 * ponytail: assumes table/column names are valid JS identifiers (snake_case is);
 * quote/escape exotic names if a real schema ever needs it.
 */
export function generateTsSchema(tables: IntrospectedTable[]): string {
  const used = new Set<string>(["pgTable"]);
  const blocks: string[] = [];

  for (const table of tables) {
    const lines: string[] = [];
    for (const col of table.columns) {
      const { helper, fallback } = helperFor(col.dataType);
      used.add(helper);
      let expr = `${helper}("${col.name}")`;
      if (col.isPk) expr += ".primaryKey()";
      else if (!col.nullable) expr += ".notNull()";
      const todo = fallback ? ` // TODO: ${col.dataType} mapped to text()` : "";
      lines.push(`  ${col.name}: ${expr},${todo}`);
    }
    blocks.push(`export const ${table.name} = pgTable("${table.name}", {\n${lines.join("\n")}\n});`);
  }

  const imports = [...used].sort();
  const header = `import { ${imports.join(", ")} } from "@podkit/db";`;
  return `${header}\n\n${blocks.join("\n\n")}\n`;
}

async function introspect(client: DbClient): Promise<IntrospectedTable[]> {
  const tableRows = (await client.raw(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_podkit_migrations' ORDER BY table_name`,
  )) as TableRow[];

  const pkRows = (await client.raw(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'`,
  )) as PkRow[];
  const pkSet = new Set(pkRows.map((r) => `${r.table_name}.${r.column_name}`));

  const tables: IntrospectedTable[] = [];
  for (const { table_name } of tableRows) {
    const columnRows = (await client.raw(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table_name],
    )) as ColumnRow[];
    tables.push({
      name: table_name,
      columns: columnRows.map((col) => ({
        name: col.column_name,
        dataType: col.data_type,
        nullable: col.is_nullable !== "NO",
        isPk: pkSet.has(`${table_name}.${col.column_name}`),
      })),
    });
  }
  return tables;
}

/**
 * Introspect the live database and write the schema back to code: a versioned
 * SQL migration (capturing out-of-band DDL) AND a drizzle `schema.ts` so the
 * "schema as code" source of truth can be regenerated when adopting an existing
 * database. Works on pglite + real Postgres (information_schema only).
 */
export async function pullSchema(opts: {
  client: DbClient;
  outDir: string;
  timestamp: number;
  /** Where to write the regenerated TS schema. Defaults to <outDir>/../schema.ts. */
  schemaFile?: string;
}): Promise<{ migrationFile: string; schemaFile: string; tables: string[] }> {
  const { client, outDir, timestamp } = opts;
  const tables = await introspect(client);

  // SQL migration — reconstructed CREATE TABLE statements (unchanged behaviour).
  const sql = tables
    .map((t) => {
      const cols = t.columns.map(
        (c) => `  "${c.name}" ${c.dataType}${c.nullable ? "" : " NOT NULL"}`,
      );
      return `CREATE TABLE "${t.name}" (\n${cols.join(",\n")}\n);`;
    })
    .join("\n\n");

  mkdirSync(outDir, { recursive: true });
  const migrationFile = join(outDir, migrationFilename(timestamp, "pull"));
  writeFileSync(migrationFile, sql, "utf-8");

  // TypeScript schema — the regenerated drizzle source of truth.
  const schemaFile = opts.schemaFile ?? join(outDir, "..", "schema.ts");
  writeFileSync(schemaFile, generateTsSchema(tables), "utf-8");

  return { migrationFile, schemaFile, tables: tables.map((t) => t.name) };
}
