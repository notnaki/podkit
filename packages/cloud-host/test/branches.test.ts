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

// Databases this suite provisions (project base + branches), dropped in afterAll.
const provisionedDatabases: string[] = [];

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

async function databaseExists(name: string): Promise<boolean> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    return res.rowCount === 1;
  } finally {
    await client.end();
  }
}

async function signup(
  email: string,
): Promise<{ token: string; accountId: string }> {
  const res = await fetch(apiUrl + "/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw123456" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  return {
    token: body.data.token as string,
    accountId: body.data.account.id as string,
  };
}

beforeAll(async () => {
  pgContainer = "podkit-cp-br-" + randomBytes(4).toString("hex");
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
  const pgPort = portMatch[1]!;
  connectionString = `postgres://postgres:pk@localhost:${pgPort}/postgres`;

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
  for (const database of provisionedDatabases) {
    try {
      await dropDatabase({ adminConnectionString: connectionString, database });
    } catch {
      // ignore
    }
  }
  if (pgContainer) {
    try {
      await execFileAsync("docker", ["rm", "-f", pgContainer]);
    } catch {
      // ignore
    }
  }
}, 120000);

describe("cloud-host database branches (real Docker + Postgres)", () => {
  it(
    "creates, lists, and deletes branches with ownership gating",
    async () => {
      const suffix = randomBytes(3).toString("hex");
      const owner = await signup(`owner-${suffix}@x.com`);
      const other = await signup(`other-${suffix}@x.com`);

      const slug = `br-${suffix}`;
      const ownerJson = {
        "content-type": "application/json",
        authorization: "Bearer " + owner.token,
      };
      const otherJson = {
        "content-type": "application/json",
        authorization: "Bearer " + other.token,
      };
      const base = apiUrl + "/v1/projects/" + slug + "/branches";

      // The owner creates the project (+ managed base DB).
      const createProjectRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ slug }),
      });
      expect(createProjectRes.status).toBe(200);
      const projBody = await createProjectRes.json();
      expect(projBody.ok).toBe(true);
      provisionedDatabases.push(projBody.data.database as string);

      // --- Non-owner is blocked (403) on every branch endpoint ---
      const listOther = await fetch(base, { headers: otherJson });
      expect(listOther.status).toBe(403);
      expect((await listOther.json()).error.code).toBe("E_FORBIDDEN");

      const createOther = await fetch(base, {
        method: "POST",
        headers: otherJson,
        body: JSON.stringify({ name: "dev" }),
      });
      expect(createOther.status).toBe(403);
      expect((await createOther.json()).error.code).toBe("E_FORBIDDEN");

      const deleteOther = await fetch(base + "/dev", {
        method: "DELETE",
        headers: otherJson,
      });
      expect(deleteOther.status).toBe(403);

      // --- Unauthenticated callers are blocked (401) ---
      const listNoAuth = await fetch(base);
      expect(listNoAuth.status).toBe(401);
      expect((await listNoAuth.json()).error.code).toBe("E_UNAUTHORIZED");

      // --- Invalid branch name -> 400 ---
      const badName = await fetch(base, {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ name: "Bad Name!" }),
      });
      expect(badName.status).toBe(400);
      expect((await badName.json()).error.code).toBe("E_BAD_ARGS");

      // --- Owner creates two branches ---
      for (const name of ["dev", "staging"]) {
        const res = await fetch(base, {
          method: "POST",
          headers: ownerJson,
          body: JSON.stringify({ name }),
        });
        const body = await res.json();
        expect(res.status, name + " create").toBe(200);
        expect(body.ok).toBe(true);
        expect(body.data.branch.name).toBe(name);
        // The branch DB is the base DB name with the branch suffix.
        expect(body.data.branch.database).toBe(`proj_${slug.replace(/-/g, "_")}_${name}`);
        // The one-time scoped connection string is returned and is NOT admin.
        expect(typeof body.data.connectionString).toBe("string");
        expect(body.data.connectionString).toContain(body.data.branch.database);
        expect(body.data.connectionString).not.toContain("postgres:pk@");
        provisionedDatabases.push(body.data.branch.database as string);
      }

      // --- Duplicate name -> 400 (UNIQUE(project_id, name)) ---
      const dup = await fetch(base, {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ name: "dev" }),
      });
      expect(dup.status).toBe(400);

      // --- List shows both, name-sorted, with no secrets ---
      const list1 = await fetch(base, { headers: ownerJson });
      expect(list1.status).toBe(200);
      const list1Body = await list1.json();
      const names = (list1Body.data.branches as Array<{ name: string }>).map(
        (b) => b.name,
      );
      expect(names).toEqual(["dev", "staging"]);
      for (const b of list1Body.data.branches as Array<Record<string, unknown>>) {
        expect(b).not.toHaveProperty("connectionString");
        expect(b).not.toHaveProperty("db_url");
        expect(b).not.toHaveProperty("role");
      }

      // --- DELETE a non-existent branch -> 404 ---
      const delMissing = await fetch(base + "/nonexistent", {
        method: "DELETE",
        headers: ownerJson,
      });
      expect(delMissing.status).toBe(404);
      expect((await delMissing.json()).error.code).toBe("E_NOT_FOUND");

      // --- Delete "dev" -> 200; list then shows only "staging" ---
      const delDev = await fetch(base + "/dev", {
        method: "DELETE",
        headers: ownerJson,
      });
      expect(delDev.status).toBe(200);
      expect((await delDev.json()).data.deleted).toBe("dev");

      const list2 = await fetch(base, { headers: ownerJson });
      const list2Body = await list2.json();
      expect(
        (list2Body.data.branches as Array<{ name: string }>).map((b) => b.name),
      ).toEqual(["staging"]);
    },
    180000,
  );

  it(
    "deleting a project drops all of its branch databases (no leak)",
    async () => {
      const suffix = randomBytes(3).toString("hex");
      const owner = await signup(`del-${suffix}@x.com`);
      const slug = `del-${suffix}`;
      const ownerJson = {
        "content-type": "application/json",
        authorization: "Bearer " + owner.token,
      };

      // Create the project (+ managed base DB).
      const createProjectRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ slug }),
      });
      expect(createProjectRes.status).toBe(200);
      const projBody = await createProjectRes.json();
      const baseDb = projBody.data.database as string;
      provisionedDatabases.push(baseDb);

      // Create two branches, each backed by a real, separate Postgres DB.
      const branchDbs: string[] = [];
      const branchBase = apiUrl + "/v1/projects/" + slug + "/branches";
      for (const name of ["dev", "staging"]) {
        const res = await fetch(branchBase, {
          method: "POST",
          headers: ownerJson,
          body: JSON.stringify({ name }),
        });
        expect(res.status, name + " create").toBe(200);
        const db = (await res.json()).data.branch.database as string;
        branchDbs.push(db);
        provisionedDatabases.push(db);
      }

      // Pre-condition: base DB and both branch DBs exist in Postgres.
      expect(await databaseExists(baseDb)).toBe(true);
      for (const db of branchDbs) {
        expect(await databaseExists(db), db + " before delete").toBe(true);
      }

      // Delete the whole project (NOT the per-branch endpoint).
      const delRes = await fetch(apiUrl + "/v1/projects/" + slug, {
        method: "DELETE",
        headers: ownerJson,
      });
      expect(delRes.status).toBe(200);
      expect((await delRes.json()).data.deleted).toBe(slug);

      // Post-condition: the base DB AND every branch DB are gone — no leak.
      expect(await databaseExists(baseDb), baseDb + " after delete").toBe(false);
      for (const db of branchDbs) {
        expect(await databaseExists(db), db + " after delete").toBe(false);
      }
    },
    180000,
  );
});
