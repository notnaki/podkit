import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface DbClient {
  db: ReturnType<typeof drizzlePglite>;
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface CreateDbClientOptions {
  /** pglite data directory (local dev). Ignored when a connection string is used. */
  dataDir?: string;
  /** Postgres connection string. Falls back to the DATABASE_URL env var. */
  connectionString?: string;
}

/**
 * Create a database client.
 *
 *  - When a Postgres connection string is given (explicitly or via
 *    `DATABASE_URL`), connect to that real Postgres over node-postgres. This is
 *    what a deployed app uses: the cloud injects the project's scoped
 *    `DATABASE_URL`, so data persists in managed Postgres.
 *  - Otherwise fall back to an embedded pglite instance (local dev / tests).
 *
 * Both drivers expose the same drizzle pg-core query surface, so loaders,
 * actions, `@podkit/auth`, and `applyMigrations` work unchanged against either.
 */
export function createDbClient(opts?: CreateDbClientOptions): DbClient {
  const connectionString = opts?.connectionString ?? process.env.DATABASE_URL;

  if (connectionString) {
    const pool = new Pool({ connectionString });
    // The node-postgres and pglite drizzle instances share the pg-core query
    // API; the cast keeps DbClient.db a single type for consumers.
    const db = drizzlePg(pool) as unknown as ReturnType<typeof drizzlePglite>;
    return {
      db,
      async raw(sql: string, params?: unknown[]): Promise<unknown[]> {
        const result = await pool.query(sql, params);
        return result.rows as unknown[];
      },
      async close(): Promise<void> {
        await pool.end();
      },
    };
  }

  const pg = new PGlite(opts?.dataDir);
  const db = drizzlePglite(pg);

  return {
    db,
    async raw(sql: string, params?: unknown[]): Promise<unknown[]> {
      const result = await pg.query(sql, params as unknown[] | undefined);
      return result.rows as unknown[];
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}
