import { Pool } from "pg";

export type CreateStoreOptions = {
  connectionString: string;
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
  ) => Promise<{ id: string; slug: string } | null>;
  recordDeployment: (input: {
    projectId: string;
    version: string;
    containerId: string;
    hostPort: number;
    status: string;
    containerPort: number;
    kind: string;
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
      kind: string;
      createdAt: string | null;
    }>
  >;
  getDeploymentById: (id: string) => Promise<{
    id: string;
    projectId: string;
    version: string;
    containerPort: number;
    status: string;
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
  ) => Promise<{ id: string; email: string } | null>;
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
  close: () => Promise<void>;
};

export function createStore(opts: CreateStoreOptions): Store {
  const pool = new Pool({ connectionString: opts.connectionString });

  async function migrate(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL,
        owner text,
        created_at timestamp DEFAULT now()
      )
    `);
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
  ): Promise<{ id: string; slug: string } | null> {
    const result = await pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM projects WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, slug: row.slug };
  }

  async function recordDeployment(input: {
    projectId: string;
    version: string;
    containerId: string;
    hostPort: number;
    status: string;
    containerPort: number;
    kind: string;
  }): Promise<{ id: string }> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO deployments
         (project_id, version, container_id, host_port, container_port, kind, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.projectId,
        input.version,
        input.containerId,
        input.hostPort,
        input.containerPort,
        input.kind,
        input.status,
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
      kind: string;
      createdAt: string | null;
    }>
  > {
    const result = await pool.query<{
      id: string;
      version: string | null;
      host_port: number | null;
      status: string | null;
      container_port: number | null;
      kind: string | null;
      created_at: Date | null;
    }>(
      `SELECT id, version, host_port, status, container_port, kind, created_at
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
      kind: r.kind ?? "deploy",
      createdAt: r.created_at ? r.created_at.toISOString() : null,
    }));
  }

  async function getDeploymentById(id: string): Promise<{
    id: string;
    projectId: string;
    version: string;
    containerPort: number;
    status: string;
  } | null> {
    let result;
    try {
      result = await pool.query<{
        id: string;
        project_id: string;
        version: string | null;
        container_port: number | null;
        status: string | null;
      }>(
        `SELECT id, project_id, version, container_port, status
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
      status: row.status ?? "",
    };
  }

  async function setEnv(opts: {
    projectId: string;
    key: string;
    value: string;
    sensitive: boolean;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO project_env (project_id, key, value, sensitive)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, key)
       DO UPDATE SET value = EXCLUDED.value, sensitive = EXCLUDED.sensitive`,
      [opts.projectId, opts.key, opts.value, opts.sensitive],
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
      value: r.value,
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
  ): Promise<{ id: string; email: string } | null> {
    const result = await pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM accounts WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, email: row.email };
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

  async function close(): Promise<void> {
    await pool.end();
  }

  return {
    migrate,
    createProject,
    listProjects,
    getProjectBySlug,
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
    createCliSession,
    getCliSessionByDeviceCode,
    getCliSessionByUserCode,
    approveCliSession,
    close,
  };
}
