import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { dropDatabase } from "@podkit/db-provision";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pgContainer = "";
let connectionString = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";

async function waitForPostgres(connStr: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const c = new Client({ connectionString: connStr });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch { try { await c.end(); } catch { /* */ } await sleep(1000); }
  }
  throw new Error("Postgres not ready");
}

beforeAll(async () => {
  pgContainer = "podkit-tbl-cp-" + randomBytes(4).toString("hex");
  await execFileAsync("docker", [
    "run", "-d", "--rm", "--label", "podkit.test=1", "--name", pgContainer,
    "-e", "POSTGRES_PASSWORD=pk", "-p", "0:5432", "postgres:16-alpine",
  ]);
  const { stdout } = await execFileAsync("docker", ["port", pgContainer, "5432"]);
  const port = /:(\d+)\s*$/.exec(stdout.trim().split("\n")[0]!)![1]!;
  connectionString = `postgres://postgres:pk@localhost:${port}/postgres`;
  await waitForPostgres(connectionString);

  cloud = createCloud({
    controlPlaneConnectionString: connectionString,
    adminConnectionString: connectionString,
    apiKey: "k",
  });
  apiUrl = (await cloud.listen({ apiPort: 0, gatewayPort: 0 })).apiUrl;
}, 120000);

afterAll(async () => {
  if (cloud) { try { await cloud.close(); } catch { /* */ } }
  try { await dropDatabase({ adminConnectionString: connectionString, database: "proj_tbl", role: "proj_tbl_app" }); } catch { /* */ }
  if (pgContainer) { try { await execFileAsync("docker", ["rm", "-f", pgContainer]); } catch { /* */ } }
}, 120000);

describe("cloud-host table editor (real Postgres)", () => {
  it("browses + inserts/updates/deletes rows, scoped + ownership-gated", async () => {
    const signup = await fetch(apiUrl + "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner-" + randomBytes(4).toString("hex") + "@x.com", password: "password123" }),
    });
    const ownerToken = (await signup.json()).data.token as string;
    const owner = { "content-type": "application/json", authorization: "Bearer " + ownerToken };

    expect((await (await fetch(apiUrl + "/v1/projects", {
      method: "POST", headers: owner, body: JSON.stringify({ slug: "tbl" }),
    })).json()).ok).toBe(true);

    // Seed a table OWNED by the scoped role so the editor's scoped connection can
    // CRUD it (id is explicit int — no sequence-ownership wrinkle).
    const projDb = `postgres://postgres:pk@localhost:${connectionString.split(":")[3].split("/")[0]}/proj_tbl`;
    const admin = new Client({ connectionString: projDb });
    await admin.connect();
    await admin.query("CREATE TABLE items (id int PRIMARY KEY, label text)");
    await admin.query("ALTER TABLE items OWNER TO proj_tbl_app");
    await admin.end();

    // No creds -> 401.
    expect((await fetch(apiUrl + "/v1/projects/tbl/db/tables", { method: "GET" })).status).toBe(401);

    // Non-owner -> 403.
    const otherSignup = await fetch(apiUrl + "/v1/auth/signup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "other-" + randomBytes(4).toString("hex") + "@x.com", password: "password123" }),
    });
    const otherToken = (await otherSignup.json()).data.token as string;
    expect((await fetch(apiUrl + "/v1/projects/tbl/db/tables", {
      method: "GET", headers: { authorization: "Bearer " + otherToken },
    })).status).toBe(403);

    // List tables -> includes items with pk.
    const tablesRes = await fetch(apiUrl + "/v1/projects/tbl/db/tables", { method: "GET", headers: owner });
    expect(tablesRes.status).toBe(200);
    const tables = (await tablesRes.json()).data.tables as { name: string; columns: { name: string; isPk: boolean }[] }[];
    const items = tables.find((t) => t.name === "items")!;
    expect(items.columns.find((c) => c.name === "id")!.isPk).toBe(true);

    // Insert.
    const ins = await fetch(apiUrl + "/v1/projects/tbl/db/tables/items", {
      method: "POST", headers: owner, body: JSON.stringify({ values: { id: 1, label: "alpha" } }),
    });
    expect(ins.status).toBe(200);
    expect((await ins.json()).data.row.label).toBe("alpha");

    // Read.
    const rows = await (await fetch(apiUrl + "/v1/projects/tbl/db/tables/items", { method: "GET", headers: owner })).json();
    expect(rows.data.total).toBe(1);

    // Update.
    const upd = await fetch(apiUrl + "/v1/projects/tbl/db/tables/items", {
      method: "PATCH", headers: owner, body: JSON.stringify({ pk: { id: 1 }, values: { label: "beta" } }),
    });
    expect(upd.status).toBe(200);
    expect((await upd.json()).data.row.label).toBe("beta");

    // Delete.
    const del = await fetch(apiUrl + "/v1/projects/tbl/db/tables/items", {
      method: "DELETE", headers: owner, body: JSON.stringify({ pk: { id: 1 } }),
    });
    expect(del.status).toBe(200);
    const after = await (await fetch(apiUrl + "/v1/projects/tbl/db/tables/items", { method: "GET", headers: owner })).json();
    expect(after.data.total).toBe(0);
  }, 120000);
});
