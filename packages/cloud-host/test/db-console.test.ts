import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { dropDatabase } from "@podkit/db-provision";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEST_LABEL = "podkit.test=1";

let pgContainer = "";
let connectionString = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";

async function waitForPostgres(connStr: string, attempts = 60): Promise<void> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ connectionString: connStr });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {
        // ignore
      }
      await sleep(1000);
    }
  }
  throw new Error(
    "Postgres did not become ready: " +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

beforeAll(async () => {
  pgContainer = "podkit-dbq-cp-" + randomBytes(4).toString("hex");
  await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "--label",
    TEST_LABEL,
    "--name",
    pgContainer,
    "-e",
    "POSTGRES_PASSWORD=pk",
    "-p",
    "0:5432",
    "postgres:16-alpine",
  ]);

  const { stdout: portOut } = await execFileAsync("docker", [
    "port",
    pgContainer,
    "5432",
  ]);
  const portMatch = /:(\d+)\s*$/.exec(portOut.trim().split("\n")[0]!);
  if (!portMatch) {
    throw new Error("could not parse postgres host port: " + portOut);
  }
  connectionString = `postgres://postgres:pk@localhost:${portMatch[1]!}/postgres`;
  await waitForPostgres(connectionString);

  cloud = createCloud({
    controlPlaneConnectionString: connectionString,
    adminConnectionString: connectionString,
    apiKey: "k",
  });
  const urls = await cloud.listen({ apiPort: 0, gatewayPort: 0 });
  apiUrl = urls.apiUrl;
}, 120000);

afterAll(async () => {
  if (cloud) {
    try {
      await cloud.close();
    } catch {
      // ignore
    }
  }
  try {
    await dropDatabase({
      adminConnectionString: connectionString,
      database: "proj_dbq",
      role: "proj_dbq_app",
    });
  } catch {
    // ignore
  }
  if (pgContainer) {
    try {
      await execFileAsync("docker", ["rm", "-f", pgContainer]);
    } catch {
      // ignore
    }
  }
}, 120000);

describe("cloud-host read-only SQL runner (real Postgres)", () => {
  it(
    "runs scoped SELECTs, enforces ownership, and rejects non-SELECT/multi-statement",
    async () => {
      const ownerHeaders = {
        "content-type": "application/json",
        "x-podkit-key": "k",
      };

      // Create + own the project (provisions its scoped DB + <db>_app role).
      const ownerReg = await fetch(apiUrl + "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "owner-" + randomBytes(4).toString("hex") + "@example.com",
          password: "password123",
        }),
      });
      const ownerRegBody = await ownerReg.json();
      expect(ownerRegBody.ok).toBe(true);
      const ownerToken = ownerRegBody.data.token as string;
      const ownerBearerJson = {
        "content-type": "application/json",
        authorization: "Bearer " + ownerToken,
      };

      const created = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: ownerBearerJson,
        body: JSON.stringify({ slug: "dbq" }),
      });
      expect((await created.json()).ok).toBe(true);

      // (c) no creds -> 401.
      const noAuth = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1 AS n" }),
      });
      expect(noAuth.status).toBe(401);

      // (a) owner bearer SELECT 1 -> 200, rows[0].n === 1.
      const okRes = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: ownerBearerJson,
        body: JSON.stringify({ sql: "SELECT 1 AS n" }),
      });
      expect(okRes.status).toBe(200);
      const okBody = await okRes.json();
      expect(okBody.ok).toBe(true);
      expect(okBody.data.rows[0].n).toBe(1);

      // (g) parameterized query -> rows[0].n === 7 (value via $1, not interpolated).
      const paramRes = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: ownerBearerJson,
        body: JSON.stringify({ sql: "SELECT $1::int AS n", params: [7] }),
      });
      expect(paramRes.status).toBe(200);
      const paramBody = await paramRes.json();
      expect(paramBody.ok).toBe(true);
      expect(paramBody.data.rows[0].n).toBe(7);

      // (b) a second account bearer -> 403 E_FORBIDDEN.
      const intruderReg = await fetch(apiUrl + "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "intruder-" + randomBytes(4).toString("hex") + "@example.com",
          password: "password123",
        }),
      });
      const intruderToken = (await intruderReg.json()).data.token as string;
      const forbidden = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + intruderToken,
        },
        body: JSON.stringify({ sql: "SELECT 1 AS n" }),
      });
      expect(forbidden.status).toBe(403);
      expect((await forbidden.json()).error.code).toBe("E_FORBIDDEN");

      // (d) INSERT -> 400 E_INVALID_QUERY.
      const insert = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: ownerBearerJson,
        body: JSON.stringify({ sql: "INSERT INTO t VALUES (1)" }),
      });
      expect(insert.status).toBe(400);
      expect((await insert.json()).error.code).toBe("E_INVALID_QUERY");

      // (e) stacked statement -> 400 E_INVALID_QUERY.
      const stacked = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: ownerBearerJson,
        body: JSON.stringify({ sql: "SELECT 1; DROP TABLE x" }),
      });
      expect(stacked.status).toBe(400);
      expect((await stacked.json()).error.code).toBe("E_INVALID_QUERY");

      // (f) create a table with >1000 rows via the scoped role, then SELECT *
      //     and assert the auto-appended LIMIT 1000 caps the result.
      const projDbUrl = new URL(connectionString);
      projDbUrl.pathname = "/proj_dbq";
      const seed = new Client({ connectionString: projDbUrl.toString() });
      // Connect as admin to the project DB to seed rows (the scoped role's
      // password is internal; admin/superuser bypasses the CONNECT revoke).
      await seed.connect();
      try {
        await seed.query("CREATE TABLE IF NOT EXISTS big (id int)");
        await seed.query("INSERT INTO big SELECT generate_series(1, 1500)");
        // Make the table readable by the scoped role (admin owns this table).
        await seed.query("GRANT SELECT ON big TO proj_dbq_app");
      } finally {
        await seed.end();
      }

      const capped = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: ownerBearerJson,
        body: JSON.stringify({ sql: "SELECT * FROM big" }),
      });
      expect(capped.status).toBe(200);
      const cappedBody = await capped.json();
      expect(cappedBody.ok).toBe(true);
      expect(cappedBody.data.rows.length).toBeLessThanOrEqual(1000);

      // Sanity: ownerHeaders (machine key) also works for the runner.
      const keyRes = await fetch(apiUrl + "/v1/projects/dbq/db/query", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ sql: "SELECT 2 AS n" }),
      });
      expect(keyRes.status).toBe(200);
      expect((await keyRes.json()).data.rows[0].n).toBe(2);
    },
    240000,
  );
});
