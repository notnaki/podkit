import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, asc } from "drizzle-orm";
import { projects, deployments } from "./schema.ts";

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
    close,
  };
}
