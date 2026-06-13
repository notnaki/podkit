import { Client } from "pg";

/**
 * Sanitize a free-form project slug into a safe Postgres database identifier.
 *
 * Rules:
 * - lowercase
 * - any character that is not [a-z0-9_] becomes `_`
 * - runs of `_` are collapsed and leading/trailing `_` trimmed
 * - prefixed with `proj_` so every managed DB shares a recognizable namespace
 *
 * Examples: "My App!" -> "proj_my_app", "  foo--bar " -> "proj_foo_bar".
 */
export function sanitizeSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  // Guard against an all-symbol slug that sanitizes to nothing, and bound the
  // length so `proj_` + body stays under Postgres's 63-byte identifier limit
  // (otherwise distinct slugs sharing a 63-char prefix would collide).
  const body = (cleaned.length > 0 ? cleaned : "db").slice(0, 50);
  return `proj_${body}`;
}

/**
 * Swap the database path of a Postgres connection string, preserving creds,
 * host, port, and query params. Used to point admin creds at a new database.
 */
function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Provision a managed Postgres database for a project.
 *
 * MVP simplification: this reuses the admin role for the new database rather
 * than minting a per-project role/credentials. Per-project roles (with scoped
 * privileges and rotated secrets) can be layered on later — the returned
 * connectionString simply carries the admin creds pointed at the new DB.
 */
export async function provisionDatabase(opts: {
  adminConnectionString: string;
  slug: string;
}): Promise<{ database: string; connectionString: string }> {
  const database = sanitizeSlug(opts.slug);
  const admin = new Client({ connectionString: opts.adminConnectionString });
  await admin.connect();
  try {
    // CREATE DATABASE cannot run in a transaction and has no IF NOT EXISTS,
    // so check pg_database first to stay idempotent.
    const existing = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    if (existing.rowCount === 0) {
      // Identifier is validated by sanitizeSlug to [a-z0-9_], so quoting is
      // safe; parameters are not allowed in CREATE DATABASE.
      await admin.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await admin.end();
  }

  return {
    database,
    connectionString: withDatabase(opts.adminConnectionString, database),
  };
}

/**
 * Drop a managed database. Terminates any open connections first, since
 * DROP DATABASE fails while sessions are attached. Intended for test cleanup
 * and project teardown.
 */
export async function dropDatabase(opts: {
  adminConnectionString: string;
  database: string;
}): Promise<void> {
  const admin = new Client({ connectionString: opts.adminConnectionString });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [opts.database],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${opts.database}"`);
  } finally {
    await admin.end();
  }
}
