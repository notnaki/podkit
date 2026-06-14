import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEST_LABEL = "podkit.test=1";

let pgContainer = "";
let connectionString = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";

async function waitForPostgres(connStr: string, attempts = 30): Promise<void> {
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
      await sleep(500);
    }
  }
  throw new Error(
    "Postgres did not become ready: " +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

beforeAll(async () => {
  pgContainer = "podkit-xtenant-" + randomBytes(8).toString("hex");
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
  if (pgContainer) {
    try {
      await execFileAsync("docker", ["rm", "-f", pgContainer]);
    } catch {
      // ignore
    }
  }
}, 120000);

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
  return { token: body.data.token as string, accountId: body.data.account.id as string };
}

describe("cloud-host cross-tenant project isolation (real Docker + Postgres)", () => {
  it(
    "blocks non-owners (403) and unauthenticated callers (401) across all project-scoped endpoints",
    async () => {
      const suffix = randomBytes(3).toString("hex");
      const a = await signup(`a-${suffix}@x.com`);
      const b = await signup(`b-${suffix}@x.com`);

      // A creates project X. A maliciously tries to assign ownership to B via
      // the body — the server must IGNORE that and bind ownership to the
      // creating token (A), or the per-project authz below is meaningless.
      const slug = `xt-${suffix}`;
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + a.token,
        },
        body: JSON.stringify({ slug, owner: b.accountId }),
      });
      expect(createRes.status).toBe(200);

      const bearerB = { authorization: "Bearer " + b.token };
      const bearerBJson = {
        "content-type": "application/json",
        authorization: "Bearer " + b.token,
      };
      const base = apiUrl + "/v1/projects/" + slug;

      // --- GET reads as B -> 403 ---
      const readForbidden: Array<[string, string]> = [
        ["GET", base],
        ["GET", base + "/deployments"],
        ["GET", base + "/env"],
        ["GET", base + "/domains"],
        ["GET", base + "/logs"],
      ];
      for (const [method, urlStr] of readForbidden) {
        const res = await fetch(urlStr, { method, headers: bearerB });
        expect(res.status, method + " " + urlStr).toBe(403);
        const body = await res.json();
        expect(body.error.code).toBe("E_FORBIDDEN");
      }

      // --- Mutations as B -> 403 ---
      const deployB = await fetch(base + "/deploy", {
        method: "POST",
        headers: bearerBJson,
        body: JSON.stringify({ contextDir: "/tmp", containerPort: 3000 }),
      });
      expect(deployB.status).toBe(403);

      const envB = await fetch(base + "/env", {
        method: "POST",
        headers: bearerBJson,
        body: JSON.stringify({ key: "FOO", value: "bar" }),
      });
      expect(envB.status).toBe(403);

      const rollbackB = await fetch(base + "/rollback", {
        method: "POST",
        headers: bearerBJson,
        body: JSON.stringify({ deploymentId: "00000000-0000-0000-0000-000000000000" }),
      });
      expect(rollbackB.status).toBe(403);

      const domainB = await fetch(base + "/domains", {
        method: "POST",
        headers: bearerBJson,
        body: JSON.stringify({ domain: "evil.example.com" }),
      });
      expect(domainB.status).toBe(403);

      const delEnvB = await fetch(base + "/env/FOO", {
        method: "DELETE",
        headers: bearerB,
      });
      expect(delEnvB.status).toBe(403);

      const delDomainB = await fetch(base + "/domains/evil.example.com", {
        method: "DELETE",
        headers: bearerB,
      });
      expect(delDomainB.status).toBe(403);

      // --- B's project list does NOT include X ---
      const listB = await fetch(apiUrl + "/v1/projects", { headers: bearerB });
      expect(listB.status).toBe(200);
      const listBBody = await listB.json();
      expect(listBBody.ok).toBe(true);
      const slugsB = (listBBody.data.projects as Array<{ slug: string }>).map(
        (p) => p.slug,
      );
      expect(slugsB).not.toContain(slug);

      // --- No-token GET reads -> 401 ---
      for (const [method, urlStr] of readForbidden) {
        const res = await fetch(urlStr, { method });
        expect(res.status, "no-token " + method + " " + urlStr).toBe(401);
        const body = await res.json();
        expect(body.error.code).toBe("E_UNAUTHORIZED");
      }
      // No-token list -> 401
      const listNoToken = await fetch(apiUrl + "/v1/projects");
      expect(listNoToken.status).toBe(401);

      // --- Regression: A's own token still reads X (200) ---
      const aRead = await fetch(base, {
        headers: { authorization: "Bearer " + a.token },
      });
      expect(aRead.status).toBe(200);
      const aReadBody = await aRead.json();
      expect(aReadBody.ok).toBe(true);
      expect(aReadBody.data.project.slug).toBe(slug);

      // --- Regression: A's project list includes X ---
      const listA = await fetch(apiUrl + "/v1/projects", {
        headers: { authorization: "Bearer " + a.token },
      });
      expect(listA.status).toBe(200);
      const listABody = await listA.json();
      const slugsA = (listABody.data.projects as Array<{ slug: string }>).map(
        (p) => p.slug,
      );
      expect(slugsA).toContain(slug);
    },
    120000,
  );
});
