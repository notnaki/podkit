import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

// Postgres LISTEN/NOTIFY realtime for @podkit/db.
//
// ponytail: LISTEN/NOTIFY only. NO logical replication / WAL decoding (no
// wal2json, no Debezium-style change capture). LISTEN/NOTIFY is fire-and-forget
// (no durability, no replay of missed events while disconnected) and payloads
// are capped by Postgres at ~8000 bytes. That is the right ceiling for "tell me
// when X changed" fan-out; upgrade path is a logical-replication consumer if you
// ever need guaranteed delivery / historical catch-up.

export type NotifyHandler = (payload: string) => void;

/** Cleanup function returned by `subscribe`; idempotent. */
export type Unsubscribe = () => Promise<void>;

export interface Realtime {
  /**
   * Listen on `channel`; `handler` is called with each NOTIFY payload (the empty
   * string when a NOTIFY carries no payload). Returns an unsubscribe function
   * that stops listening and releases the dedicated connection.
   */
  subscribe(channel: string, handler: NotifyHandler): Promise<Unsubscribe>;
  /** Emit a NOTIFY on `channel` with an optional string payload. */
  notify(channel: string, payload?: string): Promise<void>;
  /** Tear down all subscriptions and shared resources. */
  close(): Promise<void>;
}

export interface CreateRealtimeOptions {
  /** Postgres connection string. Falls back to DATABASE_URL. */
  connectionString?: string;
  /**
   * Reuse an existing PGlite instance (local dev / tests). When neither this nor
   * a connection string is given, an embedded PGlite instance is created.
   */
  pglite?: PGlite;
}

// Postgres unquoted-identifier rules: a letter or underscore, then letters,
// digits, underscores, or dollar signs. We deliberately reject quoted/dotted
// names — channel names cannot be parameterized in LISTEN/NOTIFY, so the only
// safe input is a plain identifier we can interpolate without escaping.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

// Postgres lowercases unquoted identifiers and truncates them at NAMEDATALEN-1
// (63 bytes). Anything longer would silently collide with a truncated name, so
// reject it rather than interpolate a value Postgres would mangle.
const MAX_IDENT_LEN = 63;

/**
 * Validate a channel name as a safe Postgres identifier and return it. Throws on
 * anything that isn't a plain identifier — this is the injection guard, since
 * LISTEN/NOTIFY channel names are interpolated into SQL, not bound as params.
 */
export function assertChannel(channel: string): string {
  if (typeof channel !== "string" || !SAFE_IDENT.test(channel) || channel.length > MAX_IDENT_LEN) {
    throw new Error(
      `invalid realtime channel ${JSON.stringify(channel)}: must match ` +
        `${SAFE_IDENT} and be ≤${MAX_IDENT_LEN} chars (channel names cannot be parameterized)`,
    );
  }
  return channel;
}

/**
 * Build the SQL for a trigger function + trigger that emits a NOTIFY on `channel`
 * for every INSERT/UPDATE/DELETE on `table`. The payload is the row as JSON
 * (NEW for insert/update, OLD for delete).
 *
 * ponytail: payload is the whole row as JSON and is subject to the ~8000-byte
 * NOTIFY limit; wide rows will error at runtime. Upgrade path: send only the
 * primary key and have the listener re-fetch, or move to logical replication.
 */
export function notifyTriggerSql(table: string, channel: string): string {
  assertChannel(channel);
  assertChannel(table); // same identifier rules; prevents injection via table name
  const fn = `${table}_notify_${channel}`;
  return [
    `CREATE OR REPLACE FUNCTION "${fn}"() RETURNS trigger AS $$`,
    `BEGIN`,
    `  PERFORM pg_notify('${channel}', row_to_json(COALESCE(NEW, OLD))::text);`,
    `  RETURN COALESCE(NEW, OLD);`,
    `END;`,
    `$$ LANGUAGE plpgsql;`,
    `DROP TRIGGER IF EXISTS "${fn}" ON "${table}";`,
    `CREATE TRIGGER "${fn}" AFTER INSERT OR UPDATE OR DELETE ON "${table}"`,
    `  FOR EACH ROW EXECUTE FUNCTION "${fn}"();`,
  ].join("\n");
}

function createPgRealtime(connectionString: string): Realtime {
  // A dedicated Client per subscription: LISTEN binds to a single physical
  // connection, and a pooled connection could be handed to another query
  // mid-listen. NOTIFY is one-shot so it uses its own short-lived client.
  const listeners = new Set<Client>();

  return {
    async subscribe(channel, handler) {
      assertChannel(channel);
      const client = new Client({ connectionString });
      await client.connect();
      listeners.add(client);

      client.on("notification", (msg) => {
        if (msg.channel === channel) {
          // Never let a handler throw out of the notification callback — an
          // uncaught error here would surface as an unhandled 'error' on the
          // client and could crash the process.
          try {
            handler(msg.payload ?? "");
          } catch {
            /* swallow: a dropped listener must never crash the app */
          }
        }
      });
      // A connection-level error (server restart, network drop) must not crash
      // the app. Swallow; the subscription is dead and the caller can re-subscribe.
      client.on("error", () => {
        /* connection error: subscription is effectively dead */
      });

      await client.query(`LISTEN "${channel}"`);

      let done = false;
      return async () => {
        if (done) return;
        done = true;
        listeners.delete(client);
        try {
          await client.query(`UNLISTEN "${channel}"`);
        } catch {
          /* connection may already be gone */
        }
        try {
          await client.end();
        } catch {
          /* best-effort */
        }
      };
    },

    async notify(channel, payload = "") {
      assertChannel(channel);
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await client.query("SELECT pg_notify($1, $2)", [channel, payload]);
      } finally {
        await client.end();
      }
    },

    async close() {
      const all = [...listeners];
      listeners.clear();
      await Promise.all(
        all.map(async (c) => {
          try {
            await c.end();
          } catch {
            /* best-effort */
          }
        }),
      );
    },
  };
}

function createPgliteRealtime(pg: PGlite, ownsInstance: boolean): Realtime {
  // PGlite is single-connection and in-process, so LISTEN/NOTIFY works within
  // one instance (dev/test) but does NOT span processes the way real Postgres
  // does. Documented degradation: fine for local dev, not a substitute for prod.
  return {
    async subscribe(channel, handler) {
      assertChannel(channel);
      // PGlite's listen returns its own unsubscribe; wrap it and guard handler.
      const off = await pg.listen(channel, (payload) => {
        try {
          handler(payload);
        } catch {
          /* swallow */
        }
      });
      let done = false;
      return async () => {
        if (done) return;
        done = true;
        try {
          await off();
        } catch {
          /* best-effort */
        }
      };
    },

    async notify(channel, payload = "") {
      assertChannel(channel);
      // pg_notify is parameterizable, so the payload is safely bound; the channel
      // is validated above.
      await pg.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },

    async close() {
      if (ownsInstance) await pg.close();
    },
  };
}

/**
 * Create a realtime handle backed by Postgres LISTEN/NOTIFY.
 *
 *  - With a connection string (explicit or `DATABASE_URL`): node-postgres, one
 *    dedicated connection per subscription. This is the prod target.
 *  - Otherwise: an embedded/passed PGlite instance (local dev / tests). PGlite
 *    LISTEN/NOTIFY is in-process only — it will not deliver across processes.
 */
export function createRealtime(opts?: CreateRealtimeOptions): Realtime {
  const connectionString = opts?.connectionString ?? process.env.DATABASE_URL;
  if (connectionString) return createPgRealtime(connectionString);

  if (opts?.pglite) return createPgliteRealtime(opts.pglite, false);
  return createPgliteRealtime(new PGlite(), true);
}
