import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { dropDatabase } from "@podkit/db-provision";
import { containerLogs } from "@podkit/runtime";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEST_LABEL = "podkit.test=1";

let pgContainer = "";
let connectionString = "";
let fixtureDir = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";
let gatewayUrl = "";

// Databases this suite provisions (project base + branch), dropped in afterAll.
const provisionedDatabases: string[] = [];

// Best-effort, non-fatal cleanup of Docker images this suite built.
async function cleanupImages(repositoryPrefixes: string[]): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
    const toRemove = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((img) => repositoryPrefixes.some((p) => img.startsWith(p)));
    for (const tag of toRemove) {
      try {
        await execFileAsync("docker", ["rmi", "-f", tag]);
      } catch {
        // ignore: image in use, already gone, etc.
      }
    }
  } catch {
    // ignore
  }
}

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

// Poll the gateway path until the body satisfies `predicate`, returning it.
async function pollGateway(
  path: string,
  predicate: (text: string, status: number) => boolean,
  attempts = 30,
): Promise<{ text: string; status: number }> {
  let last = { text: "", status: 0 };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(gatewayUrl + path);
      const text = await res.text();
      last = { text, status: res.status };
      if (predicate(text, res.status)) return last;
    } catch (err) {
      last = { text: String(err), status: 0 };
    }
    await sleep(1000);
  }
  return last;
}

// List names of containers (running or exited) whose name starts with `prefix`.
// Used to prove the production container is actually torn down by DELETE project.
async function containersWithPrefix(prefix: string): Promise<string[]> {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    "label=" + TEST_LABEL,
    "--format",
    "{{.Names}}",
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((name) => name.startsWith(prefix));
}

async function dumpAppLogs(): Promise<string> {
  let logs = "";
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-a",
      "--filter",
      "label=" + TEST_LABEL,
      "--format",
      "{{.Names}}",
    ]);
    for (const name of stdout.trim().split("\n").filter(Boolean)) {
      if (name.startsWith("podkit-app-") || name.startsWith("podkit-preview-")) {
        try {
          logs += `\n--- logs ${name} ---\n` + (await containerLogs(name));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return logs;
}

beforeAll(async () => {
  // 1. Control-plane Postgres.
  pgContainer = "podkit-cp-pv-" + randomBytes(4).toString("hex");
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

  // 2. Fixture app: echoes its DEPLOYMENT_KIND env + DATABASE_URL presence so we
  //    can prove env inheritance + branch DB injection from the served body.
  process.env.PODKIT_BUILDS_ROOT = realpathSync(tmpdir());
  fixtureDir = mkdtempSync(join(tmpdir(), "podkit-preview-"));
  writeFileSync(
    join(fixtureDir, "Dockerfile"),
    [
      "FROM node:22-alpine",
      "WORKDIR /app",
      "COPY server.mjs .",
      "EXPOSE 3000",
      "CMD node server.mjs",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureDir, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "createServer((_req, res) => {",
      '  const kind = process.env.DEPLOYMENT_KIND ?? "unset";',
      '  const dbUrl = process.env.DATABASE_URL ?? "";',
      "  res.writeHead(200, { 'content-type': 'text/plain' });",
      "  res.end('DEPLOYMENT_KIND=' + kind + ' DATABASE_URL_SET=' + (dbUrl ? 'yes' : 'no'));",
      "}).listen(3000);",
      "",
    ].join("\n"),
  );

  cloud = createCloud({
    controlPlaneConnectionString: connectionString,
    adminConnectionString: connectionString,
    apiKey: "k",
  });
  const urls = await cloud.listen({ apiPort: 0, gatewayPort: 0 });
  apiUrl = urls.apiUrl;
  gatewayUrl = urls.gatewayUrl;
}, 120000);

afterAll(async () => {
  delete process.env.PODKIT_BUILDS_ROOT;
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
  await cleanupImages(["podkit-e2e-preview:v"]);
  if (pgContainer) {
    try {
      await execFileAsync("docker", ["rm", "-f", pgContainer]);
    } catch {
      // ignore
    }
  }
}, 120000);

describe("cloud-host branch preview deploy (real Docker + Postgres)", () => {
  it(
    "serves preview distinct from prod, injects branch conn string, gates non-owner",
    async () => {
      const owner = await signup(`pv-owner-${randomBytes(3).toString("hex")}@x.com`);
      const other = await signup(`pv-other-${randomBytes(3).toString("hex")}@x.com`);
      const slug = "e2e-preview";
      const ownerJson = {
        "content-type": "application/json",
        authorization: "Bearer " + owner.token,
      };
      const otherJson = {
        "content-type": "application/json",
        authorization: "Bearer " + other.token,
      };

      // (1) Create the project (+ managed base DB).
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ slug }),
      });
      expect(createRes.status).toBe(200);
      const createBody = await createRes.json();
      expect(createBody.ok).toBe(true);
      provisionedDatabases.push(createBody.data.database as string);

      // (2) Set a project env var inherited by BOTH prod and preview containers.
      const setEnvRes = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ key: "DEPLOYMENT_KIND", value: "production" }),
      });
      expect(setEnvRes.status).toBe(200);

      // (3) Deploy production. routeMap[slug] -> portA.
      const prodRes = await fetch(apiUrl + `/v1/projects/${slug}/deploy`, {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ contextDir: fixtureDir, containerPort: 3000 }),
      });
      expect(prodRes.status).toBe(200);
      const prodBody = await prodRes.json();
      expect(prodBody.ok).toBe(true);
      const portA = prodBody.data.hostPort as number;

      const prodServed = await pollGateway(
        "/_p/" + slug + "/",
        (t) => t.includes("DEPLOYMENT_KIND=production"),
      );
      if (!prodServed.text.includes("DEPLOYMENT_KIND=production")) {
        throw new Error(
          "prod never served. last=" + prodServed.text + (await dumpAppLogs()),
        );
      }
      // Production has the inherited env but no branch DATABASE_URL injected.
      expect(prodServed.text).toContain("DATABASE_URL_SET=no");

      // (4) Create a branch (copy-on-create clone with its own scoped DB).
      const branchRes = await fetch(apiUrl + `/v1/projects/${slug}/branches`, {
        method: "POST",
        headers: ownerJson,
        body: JSON.stringify({ name: "staging" }),
      });
      expect(branchRes.status).toBe(200);
      const branchBody = await branchRes.json();
      expect(branchBody.ok).toBe(true);
      const branchDatabase = branchBody.data.branch.database as string;
      expect(branchDatabase).toBe("proj_e2e_preview_staging");
      const branchConnString = branchBody.data.connectionString as string;
      // The branch conn string is the SCOPED role, never admin (postgres:pk@).
      expect(branchConnString).not.toContain("postgres:pk@");
      provisionedDatabases.push(branchDatabase);

      // (9 — checked early, before the preview exists) Non-owner is 403.
      const forbiddenRes = await fetch(
        apiUrl + `/v1/projects/${slug}/deploy-branch`,
        {
          method: "POST",
          headers: otherJson,
          body: JSON.stringify({
            branchName: "staging",
            contextDir: fixtureDir,
            containerPort: 3000,
          }),
        },
      );
      expect(forbiddenRes.status).toBe(403);
      expect((await forbiddenRes.json()).error.code).toBe("E_FORBIDDEN");

      // Deploy-branch against an unknown branch -> 404.
      const unknownBranchRes = await fetch(
        apiUrl + `/v1/projects/${slug}/deploy-branch`,
        {
          method: "POST",
          headers: ownerJson,
          body: JSON.stringify({
            branchName: "nope",
            contextDir: fixtureDir,
            containerPort: 3000,
          }),
        },
      );
      expect(unknownBranchRes.status).toBe(404);

      // (5) Deploy the branch preview. routeMap[slug--staging] -> portB != portA.
      const previewRes = await fetch(
        apiUrl + `/v1/projects/${slug}/deploy-branch`,
        {
          method: "POST",
          headers: ownerJson,
          body: JSON.stringify({
            branchName: "staging",
            contextDir: fixtureDir,
            containerPort: 3000,
          }),
        },
      );
      expect(previewRes.status).toBe(200);
      const previewBody = await previewRes.json();
      expect(previewBody.ok).toBe(true);
      expect(previewBody.data.branchName).toBe("staging");
      expect(previewBody.data.url).toBe(
        gatewayUrl + "/_p/" + slug + "--staging/",
      );
      const portB = previewBody.data.hostPort as number;
      expect(portB).not.toBe(portA);
      // The response must NEVER leak the injected branch connection string.
      expect(JSON.stringify(previewBody)).not.toContain(branchConnString);

      // Preview serves; inherits project env AND has the branch DATABASE_URL.
      const previewServed = await pollGateway(
        "/_p/" + slug + "--staging/",
        (t) =>
          t.includes("DEPLOYMENT_KIND=production") &&
          t.includes("DATABASE_URL_SET=yes"),
      );
      if (
        !(
          previewServed.text.includes("DEPLOYMENT_KIND=production") &&
          previewServed.text.includes("DATABASE_URL_SET=yes")
        )
      ) {
        throw new Error(
          "preview never served. last=" +
            previewServed.text +
            (await dumpAppLogs()),
        );
      }

      // (6) Branch-targeted DB query uses the branch conn string (its own DB).
      const branchQueryRes = await fetch(
        apiUrl + `/v1/projects/${slug}/db/query?branchName=staging`,
        {
          method: "POST",
          headers: ownerJson,
          body: JSON.stringify({
            sql: "SELECT current_database() AS db",
          }),
        },
      );
      expect(branchQueryRes.status).toBe(200);
      const branchQueryBody = await branchQueryRes.json();
      expect(branchQueryBody.ok).toBe(true);
      expect(branchQueryBody.data.rows[0].db).toBe(branchDatabase);

      // The project (prod) query targets the base DB — proves isolation.
      const baseQueryRes = await fetch(
        apiUrl + `/v1/projects/${slug}/db/query`,
        {
          method: "POST",
          headers: ownerJson,
          body: JSON.stringify({ sql: "SELECT current_database() AS db" }),
        },
      );
      expect(baseQueryRes.status).toBe(200);
      const baseQueryBody = await baseQueryRes.json();
      expect(baseQueryBody.data.rows[0].db).toBe("proj_e2e_preview");
      expect(baseQueryBody.data.rows[0].db).not.toBe(branchDatabase);

      // The deployments list includes the preview row with its branchId.
      const deplRes = await fetch(apiUrl + `/v1/projects/${slug}/deployments`, {
        headers: ownerJson,
      });
      const deplBody = await deplRes.json();
      const preview = (deplBody.data.deployments as any[]).find(
        (d) => d.kind === "preview",
      );
      expect(preview).toBeTruthy();
      expect(preview.branchId).toBe(branchBody.data.branch.id);
      const prodDeploy = (deplBody.data.deployments as any[]).find(
        (d) => d.kind === "deploy",
      );
      expect(prodDeploy.branchId ?? null).toBe(null);

      // (7) Production is still live on portA, unaffected by the preview.
      const prodStill = await pollGateway(
        "/_p/" + slug + "/",
        (t) => t.includes("DEPLOYMENT_KIND=production"),
      );
      expect(prodStill.status).toBe(200);
      expect(prodStill.text).toContain("DATABASE_URL_SET=no");

      // (8) Tear down the preview -> route cleared, preview URL 502, prod live.
      const stopRes = await fetch(
        apiUrl + `/v1/projects/${slug}/preview/staging`,
        { method: "DELETE", headers: ownerJson },
      );
      expect(stopRes.status).toBe(200);
      expect((await stopRes.json()).data.stopped).toBe("staging");

      const afterStop = await pollGateway(
        "/_p/" + slug + "--staging/",
        (_t, status) => status === 502,
      );
      expect(afterStop.status).toBe(502);

      // Production still serves after the preview teardown.
      const prodAfter = await pollGateway(
        "/_p/" + slug + "/",
        (t) => t.includes("DEPLOYMENT_KIND=production"),
      );
      expect(prodAfter.status).toBe(200);
      expect(prodAfter.text).toContain("DEPLOYMENT_KIND=production");

      // DELETE preview is idempotent: a second teardown is still 200.
      const stopAgain = await fetch(
        apiUrl + `/v1/projects/${slug}/preview/staging`,
        { method: "DELETE", headers: ownerJson },
      );
      expect(stopAgain.status).toBe(200);

      // Sanity: the production container is still running just before teardown.
      // (Its name is podkit-app-<slug>-<rand>.) The history at this point ends
      // with a kind="stopped" (containerId="") row from the preview teardown
      // above, so a naive "stop the last deployment row" teardown would skip the
      // real prod container and orphan it.
      const prodPrefix = "podkit-app-" + slug + "-";
      expect((await containersWithPrefix(prodPrefix)).length).toBe(1);

      // (10) Clean up: delete the project (drops base DB + cascades).
      const delProj = await fetch(apiUrl + `/v1/projects/${slug}`, {
        method: "DELETE",
        headers: ownerJson,
      });
      expect(delProj.status).toBe(200);

      // (11) DELETE project must stop the actual production container, scanning
      // newest->oldest for the deploy/rollback row rather than the trailing
      // kind="stopped" row. Containers run with --rm, so a stopped one is gone
      // from `docker ps -a`. Regression guard: before the fix the prod container
      // was left running here.
      const orphans = await containersWithPrefix(prodPrefix);
      expect(orphans).toEqual([]);
    },
    300000,
  );
});
