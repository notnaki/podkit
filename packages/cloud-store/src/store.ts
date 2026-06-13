import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, asc, and } from "drizzle-orm";
import { projects, deployments, accounts, cliSessions } from "./schema.ts";

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
  ) => Promise<{ id: string; status: string; token: string | null } | null>;
  getCliSessionByUserCode: (
    userCode: string,
  ) => Promise<{ id: string; status: string } | null>;
  approveCliSession: (input: {
    userCode: string;
    accountId: string;
    token: string;
  }) => Promise<void>;
  close: () => Promise<void>;
};

export function createStore(opts: CreateStoreOptions): Store {
  const pool = new Pool({ connectionString: opts.connectionString });
  const db = drizzle(pool);

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
        created_at timestamp DEFAULT now()
      )
    `);
  }

  async function createProject(input: {
    slug: string;
    owner: string;
  }): Promise<{ id: string; slug: string }> {
    const rows = await db
      .insert(projects)
      .values({ slug: input.slug, owner: input.owner })
      .returning({ id: projects.id, slug: projects.slug });
    const row = rows[0];
    return { id: row.id, slug: row.slug };
  }

  async function listProjects(): Promise<
    Array<{ id: string; slug: string; owner: string }>
  > {
    const rows = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        owner: projects.owner,
      })
      .from(projects);
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      owner: r.owner ?? "",
    }));
  }

  async function getProjectBySlug(
    slug: string,
  ): Promise<{ id: string; slug: string } | null> {
    const rows = await db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(eq(projects.slug, slug))
      .limit(1);
    const row = rows[0];
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
    const rows = await db
      .insert(deployments)
      .values({
        projectId: input.projectId,
        version: input.version,
        containerId: input.containerId,
        hostPort: input.hostPort,
        status: input.status,
      })
      .returning({ id: deployments.id });
    return { id: rows[0].id };
  }

  async function listDeployments(
    projectId: string,
  ): Promise<
    Array<{ id: string; version: string; hostPort: number; status: string }>
  > {
    const rows = await db
      .select({
        id: deployments.id,
        version: deployments.version,
        hostPort: deployments.hostPort,
        status: deployments.status,
      })
      .from(deployments)
      .where(eq(deployments.projectId, projectId))
      .orderBy(asc(deployments.createdAt));
    return rows.map((r) => ({
      id: r.id,
      version: r.version ?? "",
      hostPort: r.hostPort ?? 0,
      status: r.status ?? "",
    }));
  }

  async function createAccount(input: {
    email: string;
    passwordHash: string;
  }): Promise<{ id: string; email: string }> {
    const existing = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.email, input.email))
      .limit(1);
    if (existing[0]) {
      throw new Error(`account with email already exists: ${input.email}`);
    }
    const rows = await db
      .insert(accounts)
      .values({ email: input.email, passwordHash: input.passwordHash })
      .returning({ id: accounts.id, email: accounts.email });
    const row = rows[0];
    return { id: row.id, email: row.email };
  }

  async function getAccountByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string } | null> {
    const rows = await db
      .select({
        id: accounts.id,
        email: accounts.email,
        passwordHash: accounts.passwordHash,
      })
      .from(accounts)
      .where(eq(accounts.email, email))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, email: row.email, passwordHash: row.passwordHash ?? "" };
  }

  async function getAccountById(
    id: string,
  ): Promise<{ id: string; email: string } | null> {
    const rows = await db
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, email: row.email };
  }

  async function createCliSession(input: {
    deviceCode: string;
    userCode: string;
  }): Promise<{ id: string }> {
    const rows = await db
      .insert(cliSessions)
      .values({
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        status: "pending",
      })
      .returning({ id: cliSessions.id });
    return { id: rows[0].id };
  }

  async function getCliSessionByDeviceCode(
    deviceCode: string,
  ): Promise<{ id: string; status: string; token: string | null } | null> {
    const rows = await db
      .select({
        id: cliSessions.id,
        status: cliSessions.status,
        token: cliSessions.token,
      })
      .from(cliSessions)
      .where(eq(cliSessions.deviceCode, deviceCode))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, status: row.status, token: row.token ?? null };
  }

  async function getCliSessionByUserCode(
    userCode: string,
  ): Promise<{ id: string; status: string } | null> {
    const rows = await db
      .select({ id: cliSessions.id, status: cliSessions.status })
      .from(cliSessions)
      .where(eq(cliSessions.userCode, userCode))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, status: row.status };
  }

  async function approveCliSession(input: {
    userCode: string;
    accountId: string;
    token: string;
  }): Promise<void> {
    await db
      .update(cliSessions)
      .set({
        status: "approved",
        accountId: input.accountId,
        token: input.token,
      })
      .where(
        and(
          eq(cliSessions.userCode, input.userCode),
          eq(cliSessions.status, "pending"),
        ),
      );
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
