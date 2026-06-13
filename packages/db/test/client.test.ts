import { afterAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/client.ts";
import type { DbClient } from "../src/client.ts";

describe("createDbClient", () => {
  let client: DbClient | undefined;

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  it("creates an in-memory db client and performs a real round-trip", async () => {
    client = createDbClient();

    // Create table
    await client.raw("create table t (id int, name text)");

    // Insert a row
    await client.raw("insert into t (id, name) values ($1, $2)", [1, "alice"]);

    // Query the row
    const rows = await client.raw("select * from t order by id");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, name: "alice" });
  });
});
