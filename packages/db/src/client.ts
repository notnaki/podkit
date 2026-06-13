import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

export interface DbClient {
  db: ReturnType<typeof drizzle>;
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
  close(): Promise<void>;
}

export function createDbClient(opts?: { dataDir?: string }): DbClient {
  const pg = new PGlite(opts?.dataDir);
  const db = drizzle(pg);

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
