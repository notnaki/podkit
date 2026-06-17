import { Pool } from "pg";
import { createHash } from "node:crypto";
import { resolveSecretsKey } from "@podkit/auth";
import { encryptValue, decryptValue } from "./crypto.ts";

// Hash an opaque bearer token (reset/verify link) for storage at rest. The
// token is a 256-bit random value, so a plain SHA-256 (no salt/KDF) is enough:
// an attacker with the DB still can't reverse a random preimage, and we look
// rows up BY hash so there's no secret-dependent branch to time.
function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Minimal query surface the store relies on — a subset of pg.Pool. Allowing an
// injected pool keeps createStore connection-agnostic and lets tests back it
// with an embedded Postgres (PGlite) so the cascade/account logic is verifiable
// without Docker. ponytail: the subset we use; widen if the store grows needs.
export type QueryablePool = {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount?: number | null }>;
  end: () => Promise<void>;
};

export type CreateStoreOptions = {
  connectionString?: string;
  // Inject a pre-built pool (e.g. PGlite-backed in tests). When set,
  // connectionString is ignored.
  pool?: QueryablePool;
};

export type Store = {
  migrate: () => Promise<void>;
  createProject: (input: {
    slug: string;
    owner: string;
  }) => Promise<{ id: string; slug: string }>;
  listProjects: () => Promise<
    Array<{ id: string; slug: string; owner: string }>
  >;
  getProjectBySlug: (
    slug: string,
  ) => Promise<{ id: string; slug: string; owner: string } | null>;
  // Store/read the project's scoped DB connection string, encrypted at rest
  // (same key as project_env). Used by the read-only SQL runner so it never
  // re-provisions / rotates creds per query.
  setProjectDbUrl: (projectId: string, connectionString: string) => Promise<void>;
  getProjectDbUrl: (projectId: string) => Promise<string | null>;
  recordDeployment: (input: {
    projectId: string;
    version: string;
    containerId: string;
    hostPort: number;
    status: string;
    containerPort: number;
    kind: string;
    // Optional FK to project_branches.id when this deployment is a branch
    // preview. Null/undefined for production deployments (deploy/rollback).
    branchId?: string | null;
  }) => Promise<{ id: string }>;
  listDeployments: (
    projectId: string,
  ) => Promise<
    Array<{
      id: string;
      version: string;
      hostPort: number;
      status: string;
      containerPort: number;
      containerId: string;
      kind: string;
      branchId: string | null;
      createdAt: string | null;
    }>
  >;
  getDeploymentById: (id: string) => Promise<{
    id: string;
    projectId: string;
    version: string;
    containerPort: number;
    containerId: string;
    status: string;
    branchId: string | null;
  } | null>;
  setEnv: (opts: {
    projectId: string;
    key: string;
    value: string;
    sensitive: boolean;
  }) => Promise<void>;
  listEnv: (
    projectId: string,
  ) => Promise<Array<{ key: string; value: string; sensitive: boolean }>>;
  deleteEnv: (opts: { projectId: string; key: string }) => Promise<void>;
  addDomain: (opts: { projectId: string; domain: string }) => Promise<void>;
  listDomains: (projectId: string) => Promise<Array<{ domain: string }>>;
  deleteDomain: (opts: {
    projectId: string;
    domain: string;
  }) => Promise<void>;
  listAllDomains: () => Promise<Array<{ domain: string; slug: string }>>;
  createAccount: (input: {
    email: string;
    passwordHash: string;
  }) => Promise<{ id: string; email: string }>;
  getAccountByEmail: (
    email: string,
  ) => Promise<{ id: string; email: string; passwordHash: string } | null>;
  getAccountById: (
    id: string,
  ) => Promise<{ id: string; email: string; emailVerified: boolean } | null>;
  updateAccountPassword: (id: string, passwordHash: string) => Promise<void>;
  // Password reset: store only the token's SHA-256 hash; ttl in seconds.
  createPasswordResetToken: (input: {
    accountId: string;
    token: string;
    ttlSeconds: number;
  }) => Promise<void>;
  // Consume a reset token: returns the owning accountId iff the token exists,
  // is unexpired and unused; marks it used (single-use). Null otherwise.
  consumePasswordResetToken: (token: string) => Promise<string | null>;
  // Email verification: same hashed-at-rest scheme as reset tokens.
  createEmailVerifyToken: (input: {
    accountId: string;
    token: string;
    ttlSeconds: number;
  }) => Promise<void>;
  // Consume a verify token (single-use, unexpired) and flip emailVerified.
  // Returns the accountId on success, null otherwise.
  consumeEmailVerifyToken: (token: string) => Promise<string | null>;
  // Cascade-delete an account: its projects' control-plane rows (via the
  // provided per-project teardown), then the account's auth artifacts and the
  // account row. Returns the deleted projects so the caller can drop their
  // databases/containers. Idempotent for an unknown id (returns []).
  deleteAccountCascade: (
    accountId: string,
    teardownProject: (project: { id: string; slug: string }) => Promise<void>,
  ) => Promise<Array<{ id: string; slug: string }>>;
  createCliSession: (input: {
    deviceCode: string;
    userCode: string;
  }) => Promise<{ id: string }>;
  getCliSessionByDeviceCode: (
    deviceCode: string,
  ) => Promise<{
    id: string;
    status: string;
    token: string | null;
    expiresAt: string | null;
    expired: boolean;
  } | null>;
  getCliSessionByUserCode: (
    userCode: string,
  ) => Promise<{ id: string; status: string } | null>;
  approveCliSession: (input: {
    userCode: string;
    accountId: string;
    token: string;
  }) => Promise<boolean>;
  revokeToken: (jti: string, expiresAt: Date) => Promise<void>;
  isTokenRevoked: (jti: string) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<void>;
  addBranch: (opts: {
    projectId: string;
    name: string;
    database: string;
    role?: string;
    connectionString: string;
  }) => Promise<{ id: string }>;
  listBranches: (
    projectId: string,
  ) => Promise<
    Array<{ id: string; name: string; database: string; createdAt: string }>
  >;
  getBranchByName: (
    projectId: string,
    name: string,
  ) => Promise<{
    id: string;
    name: string;
    database: string;
    role: string | null;
    connectionString: string | null;
  } | null>;
  deleteBranch: (projectId: string, name: string) => Promise<void>;
  getBranchConnectionString: (branchId: string) => Promise<string | null>;
  getProjectById: (
    id: string,
  ) => Promise<{ id: string; slug: string; owner: string } | null>;
  // ponytail: project-level roles as text; upgrade to full org/RBAC if teams grow.
  addInvite: (opts: {
    projectId: string;
    email: string;
    role: string;
    token: string;
  }) => Promise<void>;
  getInviteByToken: (token: string) => Promise<{
    id: string;
    projectId: string;
    email: string;
    role: string;
    accepted: boolean;
  } | null>;
  acceptInvite: (token: string, accountId: string) => Promise<{
    projectId: string;
    role: string;
  } | null>;
  listMembers: (projectId: string) => Promise<Array<{
    accountId: string;
    role: string;
    createdAt: string;
  }>>;
  removeMember: (projectId: string, accountId: string) => Promise<void>;
  isMember: (projectId: string, accountId: string) => Promise<string | null>;
  // ponytail: bytea blob storage; upgrade to S3/object store for large assets.
  putBlob: (opts: {
    projectId: string;
    key: string;
    contentType: string;
    data: Buffer;
    size: number;
  }) => Promise<void>;
  getBlob: (
    projectId: string,
    key: string,
  ) => Promise<{ contentType: string; data: Buffer; size: number } | null>;
  listBlobs: (
    projectId: string,
  ) => Promise<Array<{ key: string; contentType: string; size: number; createdAt: string }>>;
  deleteBlob: (projectId: string, key: string) => Promise<void>;
  addCron: (opts: {
    projectId: string;
    name: string;
    schedule: string;
    path: string;
    method: string;
  }) => Promise<{ id: string }>;
  listCrons: (projectId: string) => Promise<
    Array<{
      id: string;
      name: string;
      schedule: string;
      path: string;
      method: string;
      enabled: boolean;
      lastRunAt: string | null;
      createdAt: string | null;
    }>
  >;
  deleteCron: (projectId: string, name: string) => Promise<void>;
  listEnabledCrons: () => Promise<
    Array<{
      id: string;
      projectId: string;
      slug: string;
      name: string;
      schedule: string;
      path: string;
      method: string;
      lastRunAt: string | null;
    }>
  >;
  touchCronRun: (id: string, isoTs: string) => Promise<void>;
  close: () => Promise<void>;
};

export function createStore(opts: CreateStoreOptions): Store {
  const pool: QueryablePool =
    opts.pool ??
    (new Pool({ connectionString: opts.connectionString }) as QueryablePool);

  // Resolve the secrets-at-rest key once at store creation. When unset (dev),
  // encryption is disabled and ENV values are stored/read as plaintext. In
  // production resolveSecretsKey throws if the key is missing.
  const secretsKey = resolveSecretsKey();

  async function migrate(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL,
        owner text,
        db_url text,
        created_at timestamp DEFAULT now()
      )
    `);
    await pool.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS db_url text`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deployments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid,
        version text,
        container_id text,
        host_port integer,
        container_port integer,
        kind text DEFAULT 'deploy',
        status text,
        created_at timestamp DEFAULT now()
      )
    `);
    // Idempotent backfill for control-planes provisioned before rollback support.
    await pool.query(
      `ALTER TABLE deployments ADD COLUMN IF NOT EXISTS container_port integer`,
    );
    await pool.query(
      `ALTER TABLE deployments ADD COLUMN IF NOT EXISTS kind text DEFAULT 'deploy'`,
    );
    // Branch-preview deployments carry a FK to the branch they were built
    // against (production deployments leave it null). ON DELETE SET NULL so
    // dropping a branch never orphans/blocks its historical deployment rows.
    await pool.query(
      `ALTER TABLE deployments ADD COLUMN IF NOT EXISTS branch_id uuid`,
    );
    // Index for filtering a project's deployments by branch (preview listing).
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_deployments_project_branch
       ON deployments(project_id, branch_id)`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_env (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        sensitive boolean NOT NULL DEFAULT false,
        UNIQUE (project_id, key)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_domains (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL,
        domain text UNIQUE NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE NOT NULL,
        password_hash text,
        email_verified boolean NOT NULL DEFAULT false,
        created_at timestamp DEFAULT now()
      )
    `);
    // Idempotent backfill for control-planes provisioned before email verify.
    await pool.query(
      `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false`,
    );
    // Single-use, expiring password-reset tokens. Only the SHA-256 hash is
    // stored; the plaintext is emailed and never persisted. used_at being set
    // makes a token single-use. FK cascades on account deletion.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash text UNIQUE NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamp DEFAULT now()
      )
    `);
    // Single-use, expiring email-verification tokens (same hashed-at-rest scheme).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_verify_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash text UNIQUE NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamp DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cli_auth_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        device_code text UNIQUE NOT NULL,
        user_code text NOT NULL,
        status text NOT NULL,
        account_id uuid,
        token text,
        expires_at timestamptz,
        created_at timestamp DEFAULT now()
      )
    `);
    await pool.query(`
      ALTER TABLE cli_auth_sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz
    `);
    // Token revocation list. Rows are keyed by the token's jti claim; a row's
    // presence means the (otherwise still-valid) token must be rejected. The
    // expires_at mirrors the token's own exp so expired rows can be GC'd later.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti text PRIMARY KEY,
        expires_at timestamptz NOT NULL,
        created_at timestamp DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
      ON revoked_tokens(expires_at)
    `);
    // Per-project database branches: each row is a copy-on-create clone of the
    // project's base DB, with its own scoped role. db_url holds the scoped
    // connection string, encrypted at rest with the same key as project_env /
    // projects.db_url. UNIQUE(project_id, name) makes branch creation race-safe.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_branches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL,
        name text NOT NULL,
        database text NOT NULL,
        role text,
        db_url text,
        created_at timestamp DEFAULT now(),
        UNIQUE(project_id, name),
        FOREIGN KEY(project_id) REFERENCES projects(id)
      )
    `);
    // Wire the deployments.branch_id FK now that project_branches exists. The
    // constraint is added idempotently (catch duplicate_object 42710) and uses
    // ON DELETE SET NULL so dropping a branch preserves its deployment history.
    try {
      await pool.query(
        `ALTER TABLE deployments
           ADD CONSTRAINT deployments_branch_id_fkey
           FOREIGN KEY (branch_id) REFERENCES project_branches(id)
           ON DELETE SET NULL`,
      );
    } catch (err) {
      // 42710 duplicate_object: the constraint already exists -> no-op.
      if (
        typeof err !== "object" ||
        err === null ||
        (err as { code?: string }).code !== "42710"
      ) {
        throw err;
      }
    }
    // Project members: team sharing across accounts. UNIQUE(project_id, account_id)
    // is the dedup guard for acceptInvite's ON CONFLICT.
    // ponytail: project-level roles as text; upgrade to full org/RBAC if teams grow.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_id text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        created_at timestamp DEFAULT now(),
        UNIQUE(project_id, account_id)
      )
    `);
    // Project invites: email-based invitation tokens. UNIQUE(token) guards the
    // invite lookup; accepted=true means the invite can't be consumed again.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_invites (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        token text UNIQUE NOT NULL,
        accepted boolean NOT NULL DEFAULT false,
        created_at timestamp DEFAULT now()
      )
    `);
    // Blob/file storage: per-project binary assets, stored as bytea at rest.
    // UNIQUE(project_id, key) makes putBlob (upsert) race-safe.
    // ponytail: bytea in Postgres; upgrade to S3 if large files matter.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL,
        key text NOT NULL,
        content_type text NOT NULL,
        data bytea NOT NULL,
        size integer NOT NULL,
        created_at timestamp DEFAULT now(),
        UNIQUE(project_id, key)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crons (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL,
        name text NOT NULL,
        schedule text NOT NULL,
        path text NOT NULL,
        method text NOT NULL DEFAULT 'GET',
        enabled boolean NOT NULL DEFAULT true,
        last_run_at timestamp,
        created_at timestamp DEFAULT now(),
        UNIQUE(project_id, name),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
  }

  async function createProject(input: {
    slug: string;
    owner: string;
  }): Promise<{ id: string; slug: string }> {
    const result = await pool.query<{ id: string; slug: string }>(
      `INSERT INTO projects (slug, owner) VALUES ($1, $2) RETURNING id, slug`,
      [input.slug, input.owner],
    );
    const row = result.rows[0];
    return { id: row.id, slug: row.slug };
  }

  async function listProjects(): Promise<
    Array<{ id: string; slug: string; owner: string }>
  > {
    const result = await pool.query<{
      id: string;
      slug: string;
      owner: string | null;
    }>(`SELECT id, slug, owner FROM projects`);
    return result.rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      owner: r.owner ?? "",
    }));
  }

  async function getProjectBySlug(
    slug: string,
  ): Promise<{ id: string; slug: string; owner: string } | null> {
    const result = await pool.query<{
      id: string;
      slug: string;
      owner: string | null;
    }>(
      `SELECT id, slug, owner FROM projects WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, slug: row.slug, owner: row.owner ?? "" };
  }

  async function getProjectById(
    id: string,
  ): Promise<{ id: string; slug: string; owner: string } | null> {
    let result;
    try {
      result = await pool.query<{ id: string; slug: string; owner: string | null }>(
        `SELECT id, slug, owner FROM projects WHERE id = $1 LIMIT 1`,
        [id],
      );
    } catch {
      // Malformed id (e.g. not a valid uuid) -> treat as not found.
      return null;
    }
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, slug: row.slug, owner: row.owner ?? "" };
  }

  async function setProjectDbUrl(
    projectId: string,
    connectionString: string,
  ): Promise<void> {
    // Encrypt the scoped DB connection string at rest when a key is configured.
    const stored = secretsKey
      ? encryptValue(connectionString, secretsKey)
      : connectionString;
    await pool.query(`UPDATE projects SET db_url = $1 WHERE id = $2`, [
      stored,
      projectId,
    ]);
  }

  async function getProjectDbUrl(projectId: string): Promise<string | null> {
    const result = await pool.query<{ db_url: string | null }>(
      `SELECT db_url FROM projects WHERE id = $1 LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row || !row.db_url) return null;
    // decryptValue passes legacy plaintext through and degrades gracefully.
    return secretsKey ? decryptValue(row.db_url, secretsKey) : row.db_url;
  }

  async function recordDeployment(input: {
    projectId: string;
    version: string;
    containerId: string;
    hostPort: number;
    status: string;
    containerPort: number;
    kind: string;
    branchId?: string | null;
  }): Promise<{ id: string }> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO deployments
         (project_id, version, container_id, host_port, container_port, kind, status, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.projectId,
        input.version,
        input.containerId,
        input.hostPort,
        input.containerPort,
        input.kind,
        input.status,
        input.branchId ?? null,
      ],
    );
    return { id: result.rows[0].id };
  }

  async function listDeployments(
    projectId: string,
  ): Promise<
    Array<{
      id: string;
      version: string;
      hostPort: number;
      status: string;
      containerPort: number;
      containerId: string;
      kind: string;
      branchId: string | null;
      createdAt: string | null;
    }>
  > {
    const result = await pool.query<{
      id: string;
      version: string | null;
      host_port: number | null;
      status: string | null;
      container_port: number | null;
      container_id: string | null;
      kind: string | null;
      branch_id: string | null;
      created_at: Date | null;
    }>(
      `SELECT id, version, host_port, status, container_port, container_id, kind, branch_id, created_at
       FROM deployments
       WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      version: r.version ?? "",
      hostPort: r.host_port ?? 0,
      status: r.status ?? "",
      containerPort: r.container_port ?? 0,
      containerId: r.container_id ?? "",
      kind: r.kind ?? "deploy",
      branchId: r.branch_id ?? null,
      createdAt: r.created_at ? r.created_at.toISOString() : null,
    }));
  }

  async function getDeploymentById(id: string): Promise<{
    id: string;
    projectId: string;
    version: string;
    containerPort: number;
    containerId: string;
    status: string;
    branchId: string | null;
  } | null> {
    let result;
    try {
      result = await pool.query<{
        id: string;
        project_id: string;
        version: string | null;
        container_port: number | null;
        container_id: string | null;
        status: string | null;
        branch_id: string | null;
      }>(
        `SELECT id, project_id, version, container_port, container_id, status, branch_id
         FROM deployments WHERE id = $1 LIMIT 1`,
        [id],
      );
    } catch {
      // Malformed id (e.g. not a valid uuid) -> treat as not found.
      return null;
    }
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      version: row.version ?? "",
      containerPort: row.container_port ?? 0,
      containerId: row.container_id ?? "",
      status: row.status ?? "",
      branchId: row.branch_id ?? null,
    };
  }

  async function setEnv(opts: {
    projectId: string;
    key: string;
    value: string;
    sensitive: boolean;
  }): Promise<void> {
    // Encrypt at rest when a key is available; otherwise store plaintext.
    const storedValue = secretsKey
      ? encryptValue(opts.value, secretsKey)
      : opts.value;
    await pool.query(
      `INSERT INTO project_env (project_id, key, value, sensitive)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, key)
       DO UPDATE SET value = EXCLUDED.value, sensitive = EXCLUDED.sensitive`,
      [opts.projectId, opts.key, storedValue, opts.sensitive],
    );
  }

  async function listEnv(
    projectId: string,
  ): Promise<Array<{ key: string; value: string; sensitive: boolean }>> {
    const result = await pool.query<{
      key: string;
      value: string;
      sensitive: boolean;
    }>(
      `SELECT key, value, sensitive FROM project_env
       WHERE project_id = $1 ORDER BY key ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      key: r.key,
      // decryptValue passes through legacy plaintext (no enc: prefix) and
      // degrades gracefully when the key is missing/wrong.
      value: secretsKey ? decryptValue(r.value, secretsKey) : r.value,
      sensitive: r.sensitive,
    }));
  }

  async function deleteEnv(opts: {
    projectId: string;
    key: string;
  }): Promise<void> {
    await pool.query(
      `DELETE FROM project_env WHERE project_id = $1 AND key = $2`,
      [opts.projectId, opts.key],
    );
  }

  async function addDomain(opts: {
    projectId: string;
    domain: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO project_domains (project_id, domain) VALUES ($1, $2)`,
      [opts.projectId, opts.domain],
    );
  }

  async function listDomains(
    projectId: string,
  ): Promise<Array<{ domain: string }>> {
    const result = await pool.query<{ domain: string }>(
      `SELECT domain FROM project_domains WHERE project_id = $1 ORDER BY domain ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({ domain: r.domain }));
  }

  async function deleteDomain(opts: {
    projectId: string;
    domain: string;
  }): Promise<void> {
    await pool.query(
      `DELETE FROM project_domains WHERE project_id = $1 AND domain = $2`,
      [opts.projectId, opts.domain],
    );
  }

  async function listAllDomains(): Promise<
    Array<{ domain: string; slug: string }>
  > {
    const result = await pool.query<{ domain: string; slug: string }>(
      `SELECT d.domain AS domain, p.slug AS slug
       FROM project_domains d
       JOIN projects p ON p.id = d.project_id
       ORDER BY d.domain ASC`,
    );
    return result.rows.map((r) => ({ domain: r.domain, slug: r.slug }));
  }

  async function createAccount(input: {
    email: string;
    passwordHash: string;
  }): Promise<{ id: string; email: string }> {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE email = $1 LIMIT 1`,
      [input.email],
    );
    if (existing.rows[0]) {
      throw new Error(`account with email already exists: ${input.email}`);
    }
    const result = await pool.query<{ id: string; email: string }>(
      `INSERT INTO accounts (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
      [input.email, input.passwordHash],
    );
    const row = result.rows[0];
    return { id: row.id, email: row.email };
  }

  async function getAccountByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    const result = await pool.query<{
      id: string;
      email: string;
      password_hash: string | null;
    }>(
      `SELECT id, email, password_hash FROM accounts WHERE email = $1 LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, email: row.email, passwordHash: row.password_hash ?? "" };
  }

  async function getAccountById(
    id: string,
  ): Promise<{ id: string; email: string; emailVerified: boolean } | null> {
    let result;
    try {
      result = await pool.query<{
        id: string;
        email: string;
        email_verified: boolean;
      }>(
        `SELECT id, email, email_verified FROM accounts WHERE id = $1 LIMIT 1`,
        [id],
      );
    } catch {
      // Malformed id (e.g. not a valid uuid) -> treat as not found.
      return null;
    }
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified ?? false,
    };
  }

  async function updateAccountPassword(
    id: string,
    passwordHash: string,
  ): Promise<void> {
    await pool.query(`UPDATE accounts SET password_hash = $1 WHERE id = $2`, [
      passwordHash,
      id,
    ]);
  }

  async function createPasswordResetToken(input: {
    accountId: string;
    token: string;
    ttlSeconds: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [input.accountId, hashOpaqueToken(input.token), String(input.ttlSeconds)],
    );
  }

  async function consumePasswordResetToken(
    token: string,
  ): Promise<string | null> {
    // Atomically mark unexpired + unused token as used, returning its owner.
    const result = await pool.query<{ account_id: string }>(
      `UPDATE password_reset_tokens
         SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING account_id`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    return row ? row.account_id : null;
  }

  async function createEmailVerifyToken(input: {
    accountId: string;
    token: string;
    ttlSeconds: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO email_verify_tokens (account_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [input.accountId, hashOpaqueToken(input.token), String(input.ttlSeconds)],
    );
  }

  async function consumeEmailVerifyToken(
    token: string,
  ): Promise<string | null> {
    const result = await pool.query<{ account_id: string }>(
      `UPDATE email_verify_tokens
         SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING account_id`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    await pool.query(`UPDATE accounts SET email_verified = true WHERE id = $1`, [
      row.account_id,
    ]);
    return row.account_id;
  }

  async function deleteAccountCascade(
    accountId: string,
    teardownProject: (project: { id: string; slug: string }) => Promise<void>,
  ): Promise<Array<{ id: string; slug: string }>> {
    // Find every project owned by this account (projects.owner stores the
    // accountId for bearer-created projects).
    let owned;
    try {
      owned = await pool.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM projects WHERE owner = $1`,
        [accountId],
      );
    } catch {
      // Malformed id -> nothing owned.
      return [];
    }
    const projects = owned.rows.map((r) => ({ id: r.id, slug: r.slug }));
    // Tear each project down (containers/DB + control-plane rows) via the
    // caller-supplied teardown so this stays free of runtime/docker concerns.
    for (const project of projects) {
      await teardownProject(project);
    }
    // Reset/verify tokens cascade via FK ON DELETE CASCADE; deleting the account
    // row removes the account itself. CLI sessions reference the account but
    // don't block deletion (account_id has no FK), so clear them explicitly so
    // no live CLI token outlives its account.
    await pool.query(
      `DELETE FROM cli_auth_sessions WHERE account_id = $1`,
      [accountId],
    );
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    return projects;
  }

  async function createCliSession(input: {
    deviceCode: string;
    userCode: string;
  }): Promise<{ id: string }> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO cli_auth_sessions (device_code, user_code, status, expires_at)
       VALUES ($1, $2, 'pending', now() + interval '10 minutes') RETURNING id`,
      [input.deviceCode, input.userCode],
    );
    return { id: result.rows[0].id };
  }

  async function getCliSessionByDeviceCode(
    deviceCode: string,
  ): Promise<{
    id: string;
    status: string;
    token: string | null;
    expiresAt: string | null;
    expired: boolean;
  } | null> {
    const result = await pool.query<{
      id: string;
      status: string;
      token: string | null;
      expires_at: Date | null;
      expired: boolean;
    }>(
      `SELECT id, status, token, expires_at, (expires_at < now()) AS expired
       FROM cli_auth_sessions WHERE device_code = $1 LIMIT 1`,
      [deviceCode],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      token: row.token ?? null,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      expired: row.expired ?? false,
    };
  }

  async function getCliSessionByUserCode(
    userCode: string,
  ): Promise<{ id: string; status: string } | null> {
    const result = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM cli_auth_sessions WHERE user_code = $1 LIMIT 1`,
      [userCode],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, status: row.status };
  }

  async function approveCliSession(input: {
    userCode: string;
    accountId: string;
    token: string;
  }): Promise<boolean> {
    const result = await pool.query(
      `UPDATE cli_auth_sessions
       SET status = 'approved', account_id = $1, token = $2
       WHERE user_code = $3 AND status = 'pending' AND expires_at > now()`,
      [input.accountId, input.token, input.userCode],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async function revokeToken(jti: string, expiresAt: Date): Promise<void> {
    // Idempotent: revoking the same token twice (e.g. double logout) is a no-op.
    await pool.query(
      `INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, expiresAt],
    );
  }

  async function isTokenRevoked(jti: string): Promise<boolean> {
    const result = await pool.query<{ jti: string }>(
      `SELECT jti FROM revoked_tokens WHERE jti = $1 LIMIT 1`,
      [jti],
    );
    return result.rows.length > 0;
  }

  async function deleteProject(projectId: string): Promise<void> {
    // Delete child rows first, then the project, to respect FK-safe ordering.
    await pool.query(`DELETE FROM project_env WHERE project_id = $1`, [
      projectId,
    ]);
    await pool.query(`DELETE FROM project_domains WHERE project_id = $1`, [
      projectId,
    ]);
    await pool.query(`DELETE FROM deployments WHERE project_id = $1`, [
      projectId,
    ]);
    // project_branches has a FK to projects, so its rows must go first.
    await pool.query(`DELETE FROM project_branches WHERE project_id = $1`, [
      projectId,
    ]);
    // Blobs are scoped to the project; remove them before the project row.
    await pool.query(`DELETE FROM blobs WHERE project_id = $1`, [projectId]);
    // Crons cascade via FK, but delete explicitly for clarity / pre-FK rows.
    await pool.query(`DELETE FROM crons WHERE project_id = $1`, [projectId]);
    // Members and invites cascade via FK ON DELETE CASCADE on project_id, so no
    // explicit DELETE is needed — but we do it explicitly for clarity and in case
    // the FK was added after rows already exist.
    await pool.query(`DELETE FROM project_members WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM project_invites WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }

  async function addBranch(opts: {
    projectId: string;
    name: string;
    database: string;
    role?: string;
    connectionString: string;
  }): Promise<{ id: string }> {
    // Defense-in-depth: the API also validates, but the store must never persist
    // a branch name that couldn't have produced a valid DB identifier.
    if (!/^[a-z0-9][a-z0-9_]{0,49}$/.test(opts.name)) {
      throw new Error(
        "invalid branch name: must match ^[a-z0-9][a-z0-9_]{0,49}$ (1-50 chars)",
      );
    }
    // Encrypt the scoped DB connection string at rest when a key is configured.
    const stored = secretsKey
      ? encryptValue(opts.connectionString, secretsKey)
      : opts.connectionString;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO project_branches (project_id, name, database, role, db_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [opts.projectId, opts.name, opts.database, opts.role ?? null, stored],
    );
    return { id: result.rows[0].id };
  }

  async function listBranches(
    projectId: string,
  ): Promise<
    Array<{ id: string; name: string; database: string; createdAt: string }>
  > {
    // No secrets in the list: db_url/role are deliberately omitted.
    const result = await pool.query<{
      id: string;
      name: string;
      database: string;
      created_at: Date | null;
    }>(
      `SELECT id, name, database, created_at FROM project_branches
       WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      database: r.database,
      createdAt: r.created_at ? r.created_at.toISOString() : "",
    }));
  }

  async function getBranchByName(
    projectId: string,
    name: string,
  ): Promise<{
    id: string;
    name: string;
    database: string;
    role: string | null;
    connectionString: string | null;
  } | null> {
    const result = await pool.query<{
      id: string;
      name: string;
      database: string;
      role: string | null;
      db_url: string | null;
    }>(
      `SELECT id, name, database, role, db_url FROM project_branches
       WHERE project_id = $1 AND name = $2 LIMIT 1`,
      [projectId, name],
    );
    const row = result.rows[0];
    if (!row) return null;
    const connectionString = row.db_url
      ? secretsKey
        ? decryptValue(row.db_url, secretsKey)
        : row.db_url
      : null;
    return {
      id: row.id,
      name: row.name,
      database: row.database,
      role: row.role,
      connectionString,
    };
  }

  async function deleteBranch(projectId: string, name: string): Promise<void> {
    await pool.query(
      `DELETE FROM project_branches WHERE project_id = $1 AND name = $2`,
      [projectId, name],
    );
  }

  async function putBlob(opts: {
    projectId: string;
    key: string;
    contentType: string;
    data: Buffer;
    size: number;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO blobs (project_id, key, content_type, data, size)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, key)
       DO UPDATE SET content_type = EXCLUDED.content_type,
                     data = EXCLUDED.data,
                     size = EXCLUDED.size,
                     created_at = now()`,
      [opts.projectId, opts.key, opts.contentType, opts.data, opts.size],
    );
  }

  async function getBlob(
    projectId: string,
    key: string,
  ): Promise<{ contentType: string; data: Buffer; size: number } | null> {
    const result = await pool.query<{
      content_type: string;
      data: Buffer;
      size: number;
    }>(
      `SELECT content_type, data, size FROM blobs
       WHERE project_id = $1 AND key = $2 LIMIT 1`,
      [projectId, key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contentType: row.content_type,
      data: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data),
      size: row.size,
    };
  }

  async function listBlobs(
    projectId: string,
  ): Promise<Array<{ key: string; contentType: string; size: number; createdAt: string }>> {
    const result = await pool.query<{
      key: string;
      content_type: string;
      size: number;
      created_at: Date | null;
    }>(
      `SELECT key, content_type, size, created_at FROM blobs
       WHERE project_id = $1 ORDER BY key ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      key: r.key,
      contentType: r.content_type,
      size: r.size,
      createdAt: r.created_at ? r.created_at.toISOString() : "",
    }));
  }

  async function deleteBlob(projectId: string, key: string): Promise<void> {
    await pool.query(
      `DELETE FROM blobs WHERE project_id = $1 AND key = $2`,
      [projectId, key],
    );
  }

  async function addCron(opts: {
    projectId: string;
    name: string;
    schedule: string;
    path: string;
    method: string;
  }): Promise<{ id: string }> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO crons (project_id, name, schedule, path, method)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [opts.projectId, opts.name, opts.schedule, opts.path, opts.method],
    );
    return { id: result.rows[0].id };
  }

  async function listCrons(projectId: string): Promise<
    Array<{
      id: string;
      name: string;
      schedule: string;
      path: string;
      method: string;
      enabled: boolean;
      lastRunAt: string | null;
      createdAt: string | null;
    }>
  > {
    const result = await pool.query<{
      id: string;
      name: string;
      schedule: string;
      path: string;
      method: string;
      enabled: boolean;
      last_run_at: Date | null;
      created_at: Date | null;
    }>(
      `SELECT id, name, schedule, path, method, enabled, last_run_at, created_at
       FROM crons WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      schedule: r.schedule,
      path: r.path,
      method: r.method,
      enabled: r.enabled,
      lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
      createdAt: r.created_at ? r.created_at.toISOString() : null,
    }));
  }

  async function deleteCron(projectId: string, name: string): Promise<void> {
    await pool.query(`DELETE FROM crons WHERE project_id = $1 AND name = $2`, [
      projectId,
      name,
    ]);
  }

  async function listEnabledCrons(): Promise<
    Array<{
      id: string;
      projectId: string;
      slug: string;
      name: string;
      schedule: string;
      path: string;
      method: string;
      lastRunAt: string | null;
    }>
  > {
    const result = await pool.query<{
      id: string;
      project_id: string;
      slug: string;
      name: string;
      schedule: string;
      path: string;
      method: string;
      last_run_at: Date | null;
    }>(
      `SELECT c.id, c.project_id, p.slug, c.name, c.schedule, c.path, c.method, c.last_run_at
       FROM crons c
       JOIN projects p ON p.id = c.project_id
       WHERE c.enabled = true
       ORDER BY c.name ASC`,
    );
    return result.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      slug: r.slug,
      name: r.name,
      schedule: r.schedule,
      path: r.path,
      method: r.method,
      lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
    }));
  }

  async function touchCronRun(id: string, isoTs: string): Promise<void> {
    await pool.query(`UPDATE crons SET last_run_at = $1 WHERE id = $2`, [
      isoTs,
      id,
    ]);
  }

  // ponytail: project-level roles as text; upgrade to full org/RBAC if teams grow.
  async function addInvite(opts: {
    projectId: string;
    email: string;
    role: string;
    token: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO project_invites (project_id, email, role, token)
       VALUES ($1, $2, $3, $4)`,
      [opts.projectId, opts.email, opts.role, opts.token],
    );
  }

  async function getInviteByToken(token: string): Promise<{
    id: string;
    projectId: string;
    email: string;
    role: string;
    accepted: boolean;
  } | null> {
    const result = await pool.query<{
      id: string;
      project_id: string;
      email: string;
      role: string;
      accepted: boolean;
    }>(
      `SELECT id, project_id, email, role, accepted FROM project_invites
       WHERE token = $1 LIMIT 1`,
      [token],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      email: row.email,
      role: row.role,
      accepted: row.accepted,
    };
  }

  // Idempotent: if the member row already exists (e.g. double-accept) the ON
  // CONFLICT is a no-op. The invite is still marked accepted so subsequent calls
  // to getInviteByToken see accepted=true.
  async function acceptInvite(
    token: string,
    accountId: string,
  ): Promise<{ projectId: string; role: string } | null> {
    // Fetch-then-update is safe here because invite tokens are single-use opaque
    // random values and Node is single-threaded; a race would just double-insert
    // and the ON CONFLICT guard absorbs it.
    const result = await pool.query<{
      project_id: string;
      role: string;
      accepted: boolean;
    }>(
      `SELECT project_id, role, accepted FROM project_invites
       WHERE token = $1 LIMIT 1`,
      [token],
    );
    const row = result.rows[0];
    if (!row) return null;
    // Mark accepted (idempotent: no-op if already true).
    await pool.query(
      `UPDATE project_invites SET accepted = true WHERE token = $1`,
      [token],
    );
    // Insert member (idempotent via ON CONFLICT DO NOTHING).
    await pool.query(
      `INSERT INTO project_members (project_id, account_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, account_id) DO NOTHING`,
      [row.project_id, accountId, row.role],
    );
    return { projectId: row.project_id, role: row.role };
  }

  async function listMembers(projectId: string): Promise<Array<{
    accountId: string;
    role: string;
    createdAt: string;
  }>> {
    const result = await pool.query<{
      account_id: string;
      role: string;
      created_at: Date | null;
    }>(
      `SELECT account_id, role, created_at FROM project_members
       WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      accountId: r.account_id,
      role: r.role,
      createdAt: r.created_at ? r.created_at.toISOString() : "",
    }));
  }

  async function removeMember(projectId: string, accountId: string): Promise<void> {
    await pool.query(
      `DELETE FROM project_members WHERE project_id = $1 AND account_id = $2`,
      [projectId, accountId],
    );
  }

  async function isMember(projectId: string, accountId: string): Promise<string | null> {
    const result = await pool.query<{ role: string }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND account_id = $2 LIMIT 1`,
      [projectId, accountId],
    );
    const row = result.rows[0];
    return row ? row.role : null;
  }

  async function getBranchConnectionString(
    branchId: string,
  ): Promise<string | null> {
    let result;
    try {
      result = await pool.query<{ db_url: string | null }>(
        `SELECT db_url FROM project_branches WHERE id = $1 LIMIT 1`,
        [branchId],
      );
    } catch {
      // Malformed id (e.g. not a valid uuid) -> treat as not found.
      return null;
    }
    const row = result.rows[0];
    if (!row || !row.db_url) return null;
    return secretsKey ? decryptValue(row.db_url, secretsKey) : row.db_url;
  }

  async function close(): Promise<void> {
    await pool.end();
  }

  return {
    migrate,
    createProject,
    listProjects,
    getProjectBySlug,
    getProjectById,
    setProjectDbUrl,
    getProjectDbUrl,
    recordDeployment,
    listDeployments,
    getDeploymentById,
    setEnv,
    listEnv,
    deleteEnv,
    addDomain,
    listDomains,
    deleteDomain,
    listAllDomains,
    createAccount,
    getAccountByEmail,
    getAccountById,
    updateAccountPassword,
    createPasswordResetToken,
    consumePasswordResetToken,
    createEmailVerifyToken,
    consumeEmailVerifyToken,
    deleteAccountCascade,
    createCliSession,
    getCliSessionByDeviceCode,
    getCliSessionByUserCode,
    approveCliSession,
    revokeToken,
    isTokenRevoked,
    deleteProject,
    addBranch,
    listBranches,
    getBranchByName,
    deleteBranch,
    getBranchConnectionString,
    addInvite,
    getInviteByToken,
    acceptInvite,
    listMembers,
    removeMember,
    isMember,
    putBlob,
    getBlob,
    listBlobs,
    deleteBlob,
    addCron,
    listCrons,
    deleteCron,
    listEnabledCrons,
    touchCronRun,
    close,
  };
}
