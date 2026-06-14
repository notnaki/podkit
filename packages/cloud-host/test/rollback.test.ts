import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";
let gatewayUrl = "";

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

// Best-effort, non-fatal cleanup of Docker images this suite built. Deploys
// tag images `podkit-<slug>:v<hex>` (see host.ts); we list and remove only the
// images matching this suite's repository prefix. Failures are swallowed so
// cleanup never fails the suite.
async function cleanupImages(repositoryPrefix: string): Promise<void> {
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
      .filter((img) => img.startsWith(repositoryPrefix));
    for (const tag of toRemove) {
      try {
        await execFileAsync("docker", ["rmi", "-f", tag]);
      } catch {
        // ignore: image in use, already gone, etc.
      }
    }
  } catch {
    // ignore: docker images listing failed (daemon down, no perms, etc.)
  }
}

// Build a fixture app context dir whose HTTP server returns `marker`.
function makeFixture(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "podkit-rb-"));
  writeFileSync(
    join(dir, "Dockerfile"),
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
    join(dir, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "createServer((_req, res) => {",
      '  res.writeHead(200, { "content-type": "text/plain" });',
      `  res.end(${JSON.stringify(marker)});`,
      "}).listen(3000);",
      "",
    ].join("\n"),
  );
  return dir;
}

// Count running app containers for the "rb" project (reaping should keep this 1).
async function countRbContainers(): Promise<number> {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "--filter",
    "label=" + TEST_LABEL,
    "--format",
    "{{.Names}}",
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((n) => n.startsWith("podkit-app-rb-")).length;
}

// Poll the gateway until the served body contains `marker`.
async function waitForBody(marker: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(gatewayUrl + "/_p/rb/");
      const text = await res.text();
      if (text.includes(marker)) return text;
      last = "got body: " + text;
    } catch (err) {
      last = String(err);
    }
    await sleep(1000);
  }
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
      if (name.startsWith("podkit-app-rb-")) {
        logs += `\n--- logs ${name} ---\n` + (await containerLogs(name));
      }
    }
  } catch {
    // ignore
  }
  throw new Error(
    `gateway never served "${marker}". last=${last}${logs}`,
  );
}

beforeAll(async () => {
  pgContainer = "podkit-rb-cp-" + randomBytes(4).toString("hex");
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
  gatewayUrl = urls.gatewayUrl;
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
      database: "proj_rb",
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
  // Remove images this suite built (slug rb), best-effort.
  await cleanupImages("podkit-rb:v");
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    "label=" + TEST_LABEL,
    "--format",
    "{{.Names}}",
  ]);
  const leftover = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((n) => n === pgContainer || n.startsWith("podkit-app-rb-"));
  expect(leftover).toEqual([]);
}, 120000);

describe("cloud-host deployments history + rollback (real Docker + Postgres)", () => {
  it(
    "deploys two versions, lists history, and rolls back to the first",
    async () => {
      const headers = { "content-type": "application/json", "x-podkit-key": "k" };

      // 1. Create the project.
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug: "rb", owner: "me" }),
      });
      expect((await createRes.json()).ok).toBe(true);

      // 2. Deploy v1 ("blue") and confirm it serves.
      const blueDir = makeFixture("served-by-blue");
      const dep1 = await fetch(apiUrl + "/v1/projects/rb/deploy", {
        method: "POST",
        headers,
        body: JSON.stringify({ contextDir: blueDir, containerPort: 3000 }),
      });
      const dep1Body = await dep1.json();
      expect(dep1Body.ok).toBe(true);
      await waitForBody("served-by-blue");
      expect(await countRbContainers()).toBe(1);

      // 3. Deploy v2 ("green") and confirm the URL now serves green.
      const greenDir = makeFixture("served-by-green");
      const dep2 = await fetch(apiUrl + "/v1/projects/rb/deploy", {
        method: "POST",
        headers,
        body: JSON.stringify({ contextDir: greenDir, containerPort: 3000 }),
      });
      expect((await dep2.json()).ok).toBe(true);
      await waitForBody("served-by-green");
      // The blue container must have been reaped — only green runs now.
      expect(await countRbContainers()).toBe(1);

      // 4. List deployment history: newest-first, green is active.
      const histRes = await fetch(apiUrl + "/v1/projects/rb/deployments", {
        headers: { "x-podkit-key": "k" },
      });
      const histBody = await histRes.json();
      expect(histBody.ok).toBe(true);
      const items = histBody.data.deployments as Array<{
        id: string;
        version: string;
        kind: string;
        active: boolean;
      }>;
      expect(items.length).toBe(2);
      expect(items[0].active).toBe(true); // newest first
      expect(items[1].active).toBe(false);
      expect(items.every((d) => d.kind === "deploy")).toBe(true);

      // The non-active deployment is the rollback target (v1 / blue).
      const blueDeployment = items[1];
      const blueVersion = dep1Body.data.version as string;
      expect(blueDeployment.version).toBe(blueVersion);

      // 5. Roll back without auth -> 401.
      const noAuth = await fetch(apiUrl + "/v1/projects/rb/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: blueDeployment.id }),
      });
      expect(noAuth.status).toBe(401);

      // 6. Roll back to blue -> the URL serves blue again.
      const rbRes = await fetch(apiUrl + "/v1/projects/rb/rollback", {
        method: "POST",
        headers,
        body: JSON.stringify({ deploymentId: blueDeployment.id }),
      });
      const rbBody = await rbRes.json();
      expect(rbBody.ok).toBe(true);
      expect(rbBody.data.version).toBe(blueVersion);
      await waitForBody("served-by-blue");
      // The green container must have been reaped by the rollback — only the
      // rollback container runs now.
      expect(await countRbContainers()).toBe(1);

      // 7. History now has three rows; the newest is a rollback to blue.
      const hist2 = await (
        await fetch(apiUrl + "/v1/projects/rb/deployments", {
          headers: { "x-podkit-key": "k" },
        })
      ).json();
      const items2 = hist2.data.deployments as Array<{
        version: string;
        kind: string;
        active: boolean;
      }>;
      expect(items2.length).toBe(3);
      expect(items2[0].active).toBe(true);
      expect(items2[0].kind).toBe("rollback");
      expect(items2[0].version).toBe(blueVersion);

      // 8. Rolling back an unknown deployment id -> 404.
      const bad = await fetch(apiUrl + "/v1/projects/rb/rollback", {
        method: "POST",
        headers,
        body: JSON.stringify({
          deploymentId: "00000000-0000-0000-0000-000000000999",
        }),
      });
      expect(bad.status).toBe(404);
    },
    240000,
  );
});
