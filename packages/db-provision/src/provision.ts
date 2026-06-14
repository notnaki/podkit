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
 * Validate a branch name. A branch name must be a short, lowercase identifier
 * made of [a-z0-9_], starting with an alphanumeric (never `_`), so that the
 * derived `<baseDb>_<branchName>` database/role names stay valid Postgres
 * identifiers. We FAIL LOUD on anything out of range rather than sanitizing —
 * silently rewriting a caller's branch name would let two distinct requests
 * collide on the same database.
 */
function assertValidBranchName(branchName: string): void {
  if (
    typeof branchName !== "string" ||
    !/^[a-z0-9][a-z0-9_]{0,49}$/.test(branchName)
  ) {
    throw new Error(
      "invalid branch name: must match ^[a-z0-9][a-z0-9_]{0,49}$ (lowercase, 1-50 chars)",
    );
  }
}

/**
 * Create an **isolated branch database** as a copy-on-create clone of a base
 * project database, with its own scoped per-project login role (NOT admin).
 *
 * `CREATE DATABASE ... WITH TEMPLATE` makes a full, independent copy of the base
 * at creation time: subsequent writes to the branch never touch the base, and
 * vice versa. The branch gets the same scoped-role isolation as a normal project
 * DB (see provisionDatabase): a non-superuser LOGIN role that owns only its own
 * database + `public` schema, with PUBLIC CONNECT revoked so it can't reach any
 * other tenant's database.
 *
 * Re-creating an existing branch (42P04) is tolerated and rotates the role's
 * password, mirroring provisionDatabase's idempotent re-provision.
 */
export async function createBranchDatabase(opts: {
  adminConnectionString: string;
  baseSlug: string;
  branchName: string;
}): Promise<{ database: string; role: string; connectionString: string }> {
  assertValidBranchName(opts.branchName);
  const baseDb = sanitizeSlug(opts.baseSlug);
  const branchDb = `${baseDb}_${opts.branchName}`;
  // Guard the combined identifier against Postgres's 63-byte limit. `_app` is
  // appended to derive the role, so cap at 59 to keep the role name valid too.
  if (branchDb.length > 59) {
    throw new Error(
      "branch database name too long: shorten the project slug or branch name",
    );
  }
  const role = roleNameForDatabase(branchDb);
  // The base DB's scoped role owns every table/sequence cloned into the branch,
  // so after re-owning the database + schema we must also reassign those objects
  // to the branch role — otherwise the branch role gets "permission denied" on
  // its own (copied) tables.
  const baseRole = roleNameForDatabase(baseDb);
  const password = randomBytes(24).toString("hex");

  const admin = new Client({ connectionString: opts.adminConnectionString });
  await admin.connect();
  try {
    // 1. CREATE DATABASE ... WITH TEMPLATE fails if any session is attached to
    //    the template, so terminate all connections to the base first. We never
    //    touch the base's data — only its open sessions, briefly.
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [baseDb],
    );

    // 2. Clone the base into the branch. No IF NOT EXISTS for CREATE DATABASE,
    //    so tolerate duplicate_database (42P04) to stay race-safe. Identifiers
    //    are validated to [a-z0-9_] (sanitizeSlug + assertValidBranchName), so
    //    quoting is safe; CREATE DATABASE forbids bound parameters.
    try {
      await admin.query(
        `CREATE DATABASE "${branchDb}" WITH TEMPLATE "${baseDb}"`,
      );
    } catch (err) {
      if (!isPgCode(err, "42P04")) throw err;
    }

    // 3. Create (or rotate the password of) the branch's scoped login role. A
    //    bare CREATE ROLE is non-superuser/createdb/createrole by default.
    try {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    } catch (err) {
      if (!isPgCode(err, "42710")) throw err;
      await admin.query(
        `ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}'`,
      );
    }

    // 4. Lock the branch down to this role: revoke PUBLIC CONNECT, grant CONNECT
    //    to the role, and hand it ownership. (The clone inherits the base's
    //    owner, so we re-own it to the branch's own scoped role.)
    await admin.query(`REVOKE CONNECT ON DATABASE "${branchDb}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${branchDb}" TO "${role}"`);
    await admin.query(`ALTER DATABASE "${branchDb}" OWNER TO "${role}"`);
  } finally {
    await admin.end();
  }

  // 5. Schema-level grants run while connected to the branch DB. Give the role
  //    ownership of `public` so it has full control within its own DB.
  const adminInDb = new Client({
    connectionString: withDatabase(opts.adminConnectionString, branchDb),
  });
  await adminInDb.connect();
  try {
    await adminInDb.query(`ALTER SCHEMA public OWNER TO "${role}"`);
    await adminInDb.query(`GRANT ALL ON SCHEMA public TO "${role}"`);
    // Re-own every cloned in-database object (tables, sequences, views, etc.)
    // from the base role to the branch role, so the branch role has full access
    // to its copied data. We deliberately do NOT use `REASSIGN OWNED BY`, which
    // also reassigns *shared* objects (databases, tablespaces) owned by the base
    // role — that would steal ownership of the base database itself. Instead we
    // iterate the in-DB objects via pg_class. Identifiers are quoted with
    // format(%I) so object names with special chars are handled safely.
    await adminInDb.query(
      `DO $$
       DECLARE r record;
       BEGIN
         FOR r IN
           SELECT c.relkind, n.nspname, c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_roles o ON o.oid = c.relowner
           WHERE o.rolname = '${baseRole}'
             AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND c.relkind IN ('r','S','v','m','p')
             -- Skip sequences that are dependency-owned by a table column
             -- (serial/identity): their owner follows the owning table, and a
             -- direct ALTER SEQUENCE OWNER on them is rejected by Postgres.
             AND NOT (
               c.relkind = 'S' AND EXISTS (
                 SELECT 1 FROM pg_depend d
                 WHERE d.objid = c.oid
                   AND d.deptype = 'a'
                   AND d.refobjsubid <> 0
               )
             )
         LOOP
           IF r.relkind IN ('r','p') THEN
             EXECUTE format('ALTER TABLE %I.%I OWNER TO %I', r.nspname, r.relname, '${role}');
           ELSIF r.relkind = 'S' THEN
             EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.nspname, r.relname, '${role}');
           ELSIF r.relkind = 'v' THEN
             EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', r.nspname, r.relname, '${role}');
           ELSIF r.relkind = 'm' THEN
             EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO %I', r.nspname, r.relname, '${role}');
           END IF;
         END LOOP;
       END $$`,
    );
  } finally {
    await adminInDb.end();
  }

  return {
    database: branchDb,
    role,
    connectionString: withRoleAndDatabase(
      opts.adminConnectionString,
      role,
      password,
      branchDb,
    ),
  };
}

/**
 * Drop a branch database (and optionally its scoped role). Identical semantics
 * to dropDatabase — terminate open sessions, then DROP ... IF EXISTS — so it is
 * idempotent and safe to retry after a partial teardown.
 */
export async function dropBranchDatabase(opts: {
  adminConnectionString: string;
  database: string;
  role?: string;
}): Promise<void> {
  await dropDatabase(opts);
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
