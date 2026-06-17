import type { IncomingMessage, ServerResponse } from "node:http";
import { getTableColumns, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { DbClient } from "../client.ts";

// Cap request bodies at 1 MiB, mirroring the framework's action body limit.
const BODY_LIMIT = 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface RestHandlerOptions {
  /**
   * Mount path prefix the handler is reachable at, e.g. "/api/posts". Used to
   * carve the trailing id segment out of the URL. Defaults to "/".
   */
  basePath?: string;
}

/**
 * A request handler compatible with node:http's (req, res) signature — the same
 * shape the framework's prod-server speaks. Returns true if it handled the
 * request, false if the method/path was not one this handler serves (so a
 * caller can fall through to other routing).
 */
export type RestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// Minimal structural view of a drizzle pg table — enough to introspect columns
// and run parameterized queries without coupling to drizzle's table types.
type AnyTable = Record<string, unknown>;

interface ColumnMeta {
  /** JS property key used in drizzle queries and accepted in request bodies. */
  key: string;
  primary: boolean;
  notNull: boolean;
  hasDefault: boolean;
}

function describeColumns(table: AnyTable): { columns: ColumnMeta[]; pk: ColumnMeta | undefined } {
  const cols = getTableColumns(table as never) as Record<
    string,
    { primary: boolean; notNull: boolean; hasDefault: boolean }
  >;
  const columns: ColumnMeta[] = Object.entries(cols).map(([key, c]) => ({
    key,
    primary: c.primary,
    notNull: c.notNull,
    hasDefault: c.hasDefault,
  }));
  return { columns, pk: columns.find((c) => c.primary) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<{ value: unknown } | { error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (r: { value: unknown } | { error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.removeAllListeners("data");
        req.resume(); // drain so the socket completes cleanly
        done({ error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") {
        done({ error: "empty body" });
        return;
      }
      try {
        done({ value: JSON.parse(raw) });
      } catch {
        done({ error: "invalid JSON" });
      }
    });
    req.on("error", () => done({ error: "read error" }));
  });
}

/**
 * Validate a request body against the table's column whitelist. Returns the
 * accepted subset (only writable columns) or an error message. Rejects unknown
 * keys outright so a client can't probe/inject columns that aren't on the table.
 */
function pickWritable(
  body: Record<string, unknown>,
  columns: ColumnMeta[],
  requireNotNull: boolean,
): { values: Record<string, unknown> } | { error: string } {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    const col = byKey.get(key);
    if (!col) return { error: `unknown column: ${key}` };
    // Never let a client set the primary key — it's server-assigned/path-bound.
    if (col.primary) return { error: `cannot set primary key: ${key}` };
    values[key] = body[key];
  }
  if (requireNotNull) {
    for (const col of columns) {
      if (col.primary || col.hasDefault || !col.notNull) continue;
      if (!(col.key in values)) return { error: `missing required column: ${col.key}` };
    }
  }
  if (Object.keys(values).length === 0) return { error: "no writable columns in body" };
  return { values };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Carve the trailing id segment out of pathname given the mount basePath. */
function extractId(pathname: string, basePath: string): string | undefined {
  let rel = pathname;
  if (basePath !== "/" && rel.startsWith(basePath)) {
    rel = rel.slice(basePath.length);
  }
  rel = rel.replace(/^\/+|\/+$/g, "");
  if (rel === "") return undefined;
  if (rel.includes("/")) return undefined; // nested paths aren't part of CRUD
  return decodeURIComponent(rel);
}

/**
 * Build a CRUD-over-one-table HTTP handler:
 *   GET    {base}        → list (?limit & ?offset pagination)
 *   GET    {base}/:id    → fetch one (404 if absent)
 *   POST   {base}        → insert (body must be an object of writable columns)
 *   PATCH  {base}/:id    → partial update
 *   PUT    {base}/:id    → update (same as PATCH here — whole-row replace isn't
 *                          modelled; see ceiling)
 *   DELETE {base}/:id    → delete (404 if absent)
 *
 * All queries run through the passed-in db client (`client.db`), so row-level
 * security bound to the request principal is respected — this never opens a
 * privileged connection of its own. Inputs are parameterized by drizzle, and
 * bodies are whitelisted against the table's columns (unknown keys → 400).
 *
 * ponytail: CRUD only. No filtering/sort DSL, no relations/joins, no OpenAPI
 * generation, no PUT/PATCH semantic split (both partial-update). Upgrade path:
 * parse a ?where= grammar into drizzle operators, add an `include` opt backed by
 * drizzle relations, and emit an OpenAPI doc from describeColumns().
 */
export function createRestHandler(
  client: Pick<DbClient, "db">,
  pgTable: PgTable,
  opts: RestHandlerOptions = {},
): RestHandler {
  // drizzle's PgTable doesn't carry a string index signature; treat it as an
  // indexable record internally for column lookup and query building.
  const table = pgTable as unknown as AnyTable;
  const basePath = opts.basePath ?? "/";
  const { columns, pk } = describeColumns(table);
  if (!pk) {
    throw new Error("createRestHandler: table has no primary key column");
  }
  const db = client.db as {
    select: () => {
      from: (t: AnyTable) => {
        limit: (n: number) => {
          offset: (n: number) => Promise<unknown[]>;
        };
        where: (cond: unknown) => { limit: (n: number) => Promise<unknown[]> };
      };
    };
    insert: (t: AnyTable) => { values: (v: unknown) => { returning: () => Promise<unknown[]> } };
    update: (t: AnyTable) => {
      set: (v: unknown) => { where: (c: unknown) => { returning: () => Promise<unknown[]> } };
    };
    delete: (t: AnyTable) => { where: (c: unknown) => { returning: () => Promise<unknown[]> } };
  };
  const pkCol = (table as Record<string, unknown>)[pk.key];

  return async function restHandler(req, res): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = extractId(url.pathname, basePath);

    try {
      if (method === "GET") {
        if (id === undefined) {
          const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
          const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
          const rows = await db.select().from(table).limit(limit).offset(offset);
          sendJson(res, 200, { data: rows, limit, offset });
          return true;
        }
        const rows = await db.select().from(table).where(eq(pkCol as never, id)).limit(1);
        if (rows.length === 0) {
          sendJson(res, 404, { error: "not found" });
          return true;
        }
        sendJson(res, 200, { data: rows[0] });
        return true;
      }

      if (method === "POST") {
        if (id !== undefined) {
          sendJson(res, 400, { error: "POST does not take an id" });
          return true;
        }
        const parsed = await readJsonBody(req);
        if ("error" in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return true;
        }
        if (!isPlainObject(parsed.value)) {
          sendJson(res, 400, { error: "body must be a JSON object" });
          return true;
        }
        const picked = pickWritable(parsed.value, columns, true);
        if ("error" in picked) {
          sendJson(res, 400, { error: picked.error });
          return true;
        }
        const rows = await db.insert(table).values(picked.values).returning();
        sendJson(res, 201, { data: rows[0] });
        return true;
      }

      if (method === "PATCH" || method === "PUT") {
        if (id === undefined) {
          sendJson(res, 400, { error: "id required" });
          return true;
        }
        const parsed = await readJsonBody(req);
        if ("error" in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return true;
        }
        if (!isPlainObject(parsed.value)) {
          sendJson(res, 400, { error: "body must be a JSON object" });
          return true;
        }
        const picked = pickWritable(parsed.value, columns, false);
        if ("error" in picked) {
          sendJson(res, 400, { error: picked.error });
          return true;
        }
        const rows = await db
          .update(table)
          .set(picked.values)
          .where(eq(pkCol as never, id))
          .returning();
        if (rows.length === 0) {
          sendJson(res, 404, { error: "not found" });
          return true;
        }
        sendJson(res, 200, { data: rows[0] });
        return true;
      }

      if (method === "DELETE") {
        if (id === undefined) {
          sendJson(res, 400, { error: "id required" });
          return true;
        }
        const rows = await db.delete(table).where(eq(pkCol as never, id)).returning();
        if (rows.length === 0) {
          sendJson(res, 404, { error: "not found" });
          return true;
        }
        sendJson(res, 200, { data: rows[0] });
        return true;
      }

      res.setHeader("allow", "GET, POST, PATCH, PUT, DELETE");
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    } catch (err) {
      // A driver/constraint error (bad uuid format, FK violation, ...) is a
      // client problem far more often than a server bug, but we can't always
      // tell — surface a 400 with the message rather than leaking a 500 stack.
      sendJson(res, 400, { error: err instanceof Error ? err.message : "request failed" });
      return true;
    }
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return fallback;
  return Math.min(n, max);
}
