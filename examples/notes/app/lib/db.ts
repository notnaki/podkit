import { join } from "node:path";
import { createDbClient, type DbClient } from "@podkit/db";

// One database client per process, created lazily and shared across requests.
// In the cloud the platform injects a scoped DATABASE_URL, so createDbClient
// connects to managed Postgres; locally it falls back to an embedded pglite
// store under .podkit/appdata. The schema is created idempotently on first use
// (small app — no migration files to ship).
let ready: Promise<DbClient> | null = null;

async function init(): Promise<DbClient> {
  const client = createDbClient({ dataDir: join(process.cwd(), ".podkit/appdata") });

  // `users` mirrors @podkit/auth's schema (createAuth reads/writes it).
  await client.raw(
    `CREATE TABLE IF NOT EXISTS users (
       id uuid PRIMARY KEY,
       email text NOT NULL UNIQUE,
       password_hash text,
       created_at timestamptz DEFAULT now()
     )`,
  );
  await client.raw(
    `CREATE TABLE IF NOT EXISTS notes (
       id uuid PRIMARY KEY,
       user_id uuid NOT NULL,
       body text NOT NULL,
       created_at timestamptz DEFAULT now()
     )`,
  );
  return client;
}

export function getDb(): Promise<DbClient> {
  if (!ready) ready = init();
  return ready;
}
