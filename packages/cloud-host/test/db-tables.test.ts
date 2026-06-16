import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import {
  listTables,
  getRows,
  insertRow,
  updateRow,
  deleteRow,
} from "../src/db-tables.ts";

const containerName = `podkit-dbtables-${randomBytes(4).toString("hex")}`;
function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

let client: Client;

beforeAll(async () => {
  docker([
    "run", "-d", "--rm", "--label", "podkit.test=1", "--name", containerName,
    "-e", "POSTGRES_PASSWORD=pk", "-p", "0:5432", "postgres:16-alpine",
  ]);
  const hostPort = docker(["port", containerName, "5432"]).split("\n")[0].split(":").pop();
  const connectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    const probe = new Client({ connectionString });
    try { await probe.connect(); await probe.query("select 1"); ready = true; await probe.end(); }
    catch { try { await probe.end(); } catch { /* */ } await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!ready) throw new Error("postgres not ready");

  client = new Client({ connectionString });
  await client.connect();
  await client.query(
    `CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL, qty int)`,
  );
  // An internal-convention table that the editor should hide.
  await client.query(`CREATE TABLE _internal (id int)`);
}, 60000);

afterAll(async () => {
  try { await client.end(); } catch { /* */ }
  try { docker(["rm", "-f", containerName]); } catch { /* */ }
});

describe("db-tables", () => {
  it("lists user tables with columns + pk flag, hiding _-prefixed tables", async () => {
    const tables = await listTables(client);
    const names = tables.map((t) => t.name);
    expect(names).toContain("widgets");
    expect(names).not.toContain("_internal");

    const widgets = tables.find((t) => t.name === "widgets")!;
    const id = widgets.columns.find((c) => c.name === "id")!;
    expect(id.isPk).toBe(true);
    expect(widgets.columns.find((c) => c.name === "name")!.nullable).toBe(false);
    expect(widgets.columns.map((c) => c.name)).toEqual(["id", "name", "qty"]);
  });

  it("inserts, reads, updates and deletes rows", async () => {
    const inserted = await insertRow(client, "widgets", { name: "alpha", qty: 1 });
    expect(inserted.name).toBe("alpha");
    const id = inserted.id;

    const page = await getRows(client, "widgets", { limit: 50, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.rows[0].name).toBe("alpha");

    const updated = await updateRow(client, "widgets", { id }, { qty: 99 });
    expect(updated.qty).toBe(99);
    expect(updated.name).toBe("alpha");

    await deleteRow(client, "widgets", { id });
    expect((await getRows(client, "widgets", { limit: 50, offset: 0 })).total).toBe(0);
  });

  it("rejects unknown tables and columns (identifier whitelist)", async () => {
    await expect(getRows(client, "does_not_exist", { limit: 10, offset: 0 })).rejects.toThrow();
    await expect(insertRow(client, "widgets", { nope: 1 })).rejects.toThrow();
    // A quote-injection attempt in the table name must be rejected, not executed.
    await expect(
      getRows(client, 'widgets"; drop table widgets; --', { limit: 10, offset: 0 }),
    ).rejects.toThrow();
  });

  it("requires a non-empty row filter for update/delete", async () => {
    await expect(updateRow(client, "widgets", {}, { qty: 1 })).rejects.toThrow();
    await expect(deleteRow(client, "widgets", {})).rejects.toThrow();
  });
});
