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

// Build a fixture app that prints `marker` to stdout on boot and serves "ok".
function makeFixture(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "podkit-lg-"));
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
      `console.log(${JSON.stringify(marker)});`,
      "createServer((_req, res) => {",
      '  res.writeHead(200, { "content-type": "text/plain" });',
      '  res.end("ok");',
      "}).listen(3000);",
      "",
    ].join("\n"),
  );
  return dir;
}

async function waitServed(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(gatewayUrl + "/_p/lg/");
      if ((await res.text()) === "ok") return;
    } catch {
      // ignore
    }
    await sleep(1000);
  }
  throw new Error("gateway never served the app");
}

beforeAll(async () => {
  pgContainer = "podkit-lg-cp-" + randomBytes(4).toString("hex");
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
      database: "proj_lg",
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
    .filter((n) => n === pgContainer || n.startsWith("podkit-app-lg-"));
  expect(leftover).toEqual([]);
}, 120000);

describe("cloud-host runtime logs (real Docker + Postgres)", () => {
  it(
    "returns the active deployment's container logs",
    async () => {
      const headers = { "content-type": "application/json", "x-podkit-key": "k" };
      const keyHeader = { "x-podkit-key": "k" };

      // Logs require auth (they can contain secrets) -> 401 without credentials.
      const noAuth = await fetch(apiUrl + "/v1/projects/lg/logs");
      expect(noAuth.status).toBe(401);

      // Unknown project -> 404.
      const unknown = await fetch(apiUrl + "/v1/projects/nope/logs", {
        headers: keyHeader,
      });
      expect(unknown.status).toBe(404);

      // Create the project.
      await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug: "lg", owner: "me" }),
      });

      // No deployment yet -> empty logs, null deploymentId.
      const empty = await (
        await fetch(apiUrl + "/v1/projects/lg/logs", { headers: keyHeader })
      ).json();
      expect(empty.ok).toBe(true);
      expect(empty.data.deploymentId).toBeNull();
      expect(empty.data.logs).toBe("");

      // Deploy an app that logs a unique marker on boot.
      const marker = "booted-" + randomBytes(4).toString("hex");
      const dir = makeFixture(marker);
      const dep = await fetch(apiUrl + "/v1/projects/lg/deploy", {
        method: "POST",
        headers,
        body: JSON.stringify({ contextDir: dir, containerPort: 3000 }),
      });
      const depBody = await dep.json();
      expect(depBody.ok).toBe(true);
      await waitServed();

      // Poll the logs endpoint until the boot marker shows up.
      let found = false;
      let lastLogs = "";
      for (let i = 0; i < 20; i++) {
        const body = await (
          await fetch(apiUrl + "/v1/projects/lg/logs", { headers: keyHeader })
        ).json();
        expect(body.ok).toBe(true);
        lastLogs = body.data.logs as string;
        if (lastLogs.includes(marker)) {
          expect(body.data.deploymentId).toBeTruthy();
          expect(body.data.version).toBe(depBody.data.version);
          found = true;
          break;
        }
        await sleep(500);
      }
      if (!found) {
        throw new Error("logs never contained marker. last=" + lastLogs);
      }
    },
    240000,
  );
});
