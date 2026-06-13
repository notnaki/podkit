import type { DbClient } from "../client.ts";
import { listMigrations, readMigration } from "./files.ts";

export async function applyMigrations(opts: {
  client: DbClient;
  dir: string;
}): Promise<{ applied: string[] }> {
  const { client, dir } = opts;

  // Ensure tracking table exists
  await client.raw(
    "CREATE TABLE IF NOT EXISTS _podkit_migrations (id text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
  );

  // Query already-applied ids
  const appliedRows = await client.raw("SELECT id FROM _podkit_migrations") as { id: string }[];
  const appliedIds = new Set(appliedRows.map((row) => row.id));

  // List all migrations sorted ascending
  const migrations = listMigrations(dir);

  const applied: string[] = [];

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    // Read and split the SQL
    const sql = readMigration(migration.path);

    const DRIZZLE_SEPARATOR = "--> statement-breakpoint";
    const statements = sql.includes(DRIZZLE_SEPARATOR)
      ? sql.split(DRIZZLE_SEPARATOR)
      : [sql];

    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) {
        continue;
      }
      await client.raw(trimmed);
    }

    // Record the migration as applied
    await client.raw("INSERT INTO _podkit_migrations (id) VALUES ($1)", [migration.id]);

    applied.push(migration.id);
  }

  return { applied };
}
