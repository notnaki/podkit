export { pgTable, uuid, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

import { uuid } from "drizzle-orm/pg-core";

export function uuidPk(name = "id") {
  return uuid(name).primaryKey().defaultRandom();
}
