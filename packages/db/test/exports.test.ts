import { describe, it, expect } from "vitest";
import * as db from "../src/index.ts";

// Apps depend only on @podkit/* and import query helpers from here, never from
// drizzle-orm directly — a direct import isn't resolvable in the deployed
// standalone image. This guards that the re-export surface stays present.
describe("@podkit/db query-helper re-exports", () => {
  const helpers = [
    "eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not",
    "isNull", "isNotNull", "inArray", "notInArray", "like", "ilike",
    "between", "desc", "asc", "sql", "count",
  ] as const;

  for (const name of helpers) {
    it(`exports ${name}`, () => {
      expect(typeof (db as Record<string, unknown>)[name]).toBe("function");
    });
  }
});
