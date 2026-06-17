export { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uuidPk } from "./schema.ts";

// Query helpers re-exported so apps depend only on @podkit/* and never import
// drizzle-orm directly — that direct import isn't resolvable in the deployed
// standalone image (pnpm doesn't hoist a transitive dep to the app's tree).
// ponytail: the common operator set; reach into "drizzle-orm" for the long tail.
export {
  eq, ne, gt, gte, lt, lte, and, or, not, isNull, isNotNull,
  inArray, notInArray, like, ilike, between, desc, asc, sql, count,
} from "drizzle-orm";

export { createDbClient } from "./client.ts";
export type { DbClient } from "./client.ts";

export { migrationFilename, listMigrations, readMigration } from "./migrations/files.ts";
export type { MigrationFile } from "./migrations/files.ts";

export { generateMigration } from "./migrations/generate.ts";

export { applyMigrations } from "./migrations/apply.ts";

export { pullSchema, generateTsSchema } from "./pull.ts";

export { enableRls, ownedBy, inOrg, isAgent, customPolicy } from "./rls/policy.ts";

export { createRestHandler } from "./rest/handler.ts";
export type { RestHandler, RestHandlerOptions } from "./rest/handler.ts";

export { createRealtime, assertChannel, notifyTriggerSql } from "./realtime.ts";
export type {
  Realtime,
  CreateRealtimeOptions,
  NotifyHandler,
  Unsubscribe,
} from "./realtime.ts";
