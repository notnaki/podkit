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
  }) => Promise<{ id: string }>;
  listDeployments: (
    projectId: string,
  ) => Promise<
    Array<{ id: string; version: string; hostPort: number; status: string }>
  >;
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
        status text,
        created_at timestamp DEFAULT now()
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
  }): Promise<{ id: string }> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO deployments (project_id, version, container_id, host_port, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.projectId, input.version, input.containerId, input.hostPort, input.status],
    );
    return { id: result.rows[0].id };
  }

  async function listDeployments(
    projectId: string,
  ): Promise<
    Array<{ id: string; version: string; hostPort: number; status: string }>
  > {
    const result = await pool.query<{
      id: string;
      version: string | null;
      host_port: number | null;
      status: string | null;
    }>(
      `SELECT id, version, host_port, status FROM deployments
       WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      version: r.version ?? "",
      hostPort: r.host_port ?? 0,
      status: r.status ?? "",
    }));
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
