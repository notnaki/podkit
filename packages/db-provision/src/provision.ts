import { Client } from "pg";
import { randomBytes } from "node:crypto";

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
 * Derive the per-project login role name from a (already-sanitized) database
 * name. `<database>` is `proj_<body>` (<= 55 chars), so `<database>_app` stays
 * within Postgres's 63-byte identifier limit and remains [a-z0-9_].
 */
export function roleNameForDatabase(database: string): string {
  return `${database}_app`;
}

/** True when a pg error carries a specific SQLSTATE code. */
function isPgCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
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
 * Build a connection string that uses the per-project role + password and
 * points at the project database, keeping the admin URL's host/port/params.
 */
function withRoleAndDatabase(
  connectionString: string,
  role: string,
  password: string,
  database: string,
): string {
  const url = new URL(connectionString);
  // role is [a-z0-9_] and password is hex, so both are URL-safe as-is.
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Provision a managed Postgres database for a project, with a **scoped
 * per-project login role** — NOT the admin/superuser credentials.
 *
 * Isolation guarantees:
 * - the role is a plain LOGIN role (no SUPERUSER / CREATEDB / CREATEROLE);
 * - it owns its own database + `public` schema (full control within it);
 * - PUBLIC's default CONNECT on the database is revoked, so the role cannot be
 *   used to reach any *other* project's database, and other roles cannot reach
 *   this one. The returned connectionString carries these scoped creds.
 *
 * Re-provisioning the same slug rotates the role's password (and returns the
 * new connection string), staying idempotent for the database + role objects.
 */
export async function provisionDatabase(opts: {
  adminConnectionString: string;
  slug: string;
}): Promise<{ database: string; role: string; connectionString: string }> {
  const database = sanitizeSlug(opts.slug);
  const role = roleNameForDatabase(database);
  const password = randomBytes(24).toString("hex");

  const admin = new Client({ connectionString: opts.adminConnectionString });
  await admin.connect();
  try {
    // 1. Create the database. CREATE DATABASE has no IF NOT EXISTS, so tolerate
    //    duplicate_database (42P04) to stay idempotent and race-safe — no
    //    check-then-create TOCTOU. Identifiers are validated to [a-z0-9_], so
    //    quoting is safe; parameters are not allowed in CREATE DATABASE/ROLE.
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
    } catch (err) {
      if (!isPgCode(err, "42P04")) throw err;
    }

    // 2. Create (or rotate the password of) the per-project login role. A bare
    //    CREATE ROLE is non-superuser, non-createdb, non-createrole by default.
    //    If it already exists (duplicate_object 42710), rotate the password.
    try {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    } catch (err) {
      if (!isPgCode(err, "42710")) throw err;
      await admin.query(`ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}'`);
    }

    // 3. Lock the database down to this role: revoke the implicit PUBLIC
    //    CONNECT, grant CONNECT to the role, and hand it ownership.
    await admin.query(`REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    await admin.query(`ALTER DATABASE "${database}" OWNER TO "${role}"`);
  } finally {
    await admin.end();
  }

  // 4. Schema-level grants must run while connected to the new database. Give
  //    the role ownership of `public` so it can create tables (PG15+ no longer
  //    grants PUBLIC create on public). Admin connects as superuser, which
  //    bypasses the CONNECT revoke above.
  const adminInDb = new Client({
    connectionString: withDatabase(opts.adminConnectionString, database),
  });
  await adminInDb.connect();
  try {
    await adminInDb.query(`ALTER SCHEMA public OWNER TO "${role}"`);
    await adminInDb.query(`GRANT ALL ON SCHEMA public TO "${role}"`);
  } finally {
    await adminInDb.end();
  }

  return {
    database,
    role,
    connectionString: withRoleAndDatabase(
      opts.adminConnectionString,
      role,
      password,
      database,
    ),
  };
}

/**
 * Drop a managed database (and optionally its per-project role). Terminates any
 * open connections first, since DROP DATABASE fails while sessions are attached.
 * Intended for test cleanup and project teardown.
 */
export async function dropDatabase(opts: {
  adminConnectionString: string;
  database: string;
  role?: string;
}): Promise<void> {
  const admin = new Client({ connectionString: opts.adminConnectionString });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [opts.database],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${opts.database}"`);
    if (opts.role) {
      // The role no longer owns the dropped database, so it can be removed.
      // Identifier is server-derived ([a-z0-9_]), so quoting is safe.
      await admin.query(`DROP ROLE IF EXISTS "${opts.role}"`);
    }
  } finally {
    await admin.end();
  }
}
