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
  // 1. Start the control-plane Postgres.
  pgContainer = "podkit-cp-" + randomBytes(4).toString("hex");
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

  // 2. Build a fixture app context dir.
  // Confine the build-context sandbox to the OS temp dir so the realpath'd
  // fixture below is always allowed (on Linux tmpdir is /tmp, which the
  // default system-path denylist rejects; PODKIT_BUILDS_ROOT is the explicit
  // opt-in that overrides it). realpath so symlinked tmp dirs (macOS) match.
  process.env.PODKIT_BUILDS_ROOT = realpathSync(tmpdir());
  fixtureDir = mkdtempSync(join(tmpdir(), "podkit-app-"));
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
      'createServer((_req, res) => {',
      '  res.writeHead(200, { "content-type": "text/plain" });',
      '  res.end("hello from demo app");',
      "}).listen(3000);",
      "",
    ].join("\n"),
  );

  // 3. Bring up the cloud control-plane + gateway.
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
  try {
    await dropDatabase({
      adminConnectionString: connectionString,
      database: "proj_demo",
    });
  } catch {
    // ignore
  }
  try {
    await dropDatabase({
      adminConnectionString: connectionString,
      database: "proj_secok",
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
  // Verify no leftover labeled test containers from THIS suite. Scope to this
  // suite's own containers (pg + app) so a sibling suite running in parallel
  // (with its own labeled Postgres) doesn't cause a false failure.
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
    .filter((n) => n === pgContainer || n.startsWith("podkit-app-demo-"));
  expect(leftover).toEqual([]);
}, 120000);

describe("cloud-host full loop (real Docker + Postgres)", () => {
  it(
    "creates a project, deploys an app, and serves it through the gateway",
    async () => {
      // 1. Create project -> provisions a managed per-project DB.
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ slug: "demo", owner: "me" }),
      });
      const createBody = await createRes.json();
      expect(createBody.ok).toBe(true);
      expect(typeof createBody.data.connectionString).toBe("string");

      // Prove the managed per-project DB actually works.
      const projClient = new Client({
        connectionString: createBody.data.connectionString,
      });
      await projClient.connect();
      const sel = await projClient.query("SELECT 1 AS one");
      expect(sel.rows[0].one).toBe(1);
      await projClient.end();

      // 2. Deploy the app (builds + runs the container).
      const deployRes = await fetch(apiUrl + "/v1/projects/demo/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ contextDir: fixtureDir, containerPort: 3000 }),
      });
      const deployBody = await deployRes.json();
      expect(deployBody.ok).toBe(true);
      expect(typeof deployBody.data.url).toBe("string");

      // 3. Poll the public gateway URL until the app responds.
      let served = "";
      let lastErr: unknown = null;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(gatewayUrl + "/_p/demo/");
          const text = await res.text();
          if (text.includes("hello from demo app")) {
            served = text;
            break;
          }
          lastErr = "got body: " + text;
        } catch (err) {
          lastErr = err;
        }
        await sleep(1000);
      }
      if (!served.includes("hello from demo app")) {
        // Capture container logs to aid environmental debugging.
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
            if (name.startsWith("podkit-app-")) {
              logs += `\n--- logs ${name} ---\n` + (await containerLogs(name));
            }
          }
        } catch {
          // ignore
        }
        throw new Error(
          "gateway never served the app. last=" +
            String(lastErr) +
            logs,
        );
      }
      expect(served).toContain("hello from demo app");

      // 4. Deploy without the API key -> 401 E_UNAUTHORIZED.
      const unauthRes = await fetch(apiUrl + "/v1/projects/demo/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contextDir: fixtureDir, containerPort: 3000 }),
      });
      expect(unauthRes.status).toBe(401);
      const unauthBody = await unauthRes.json();
      expect(unauthBody.ok).toBe(false);
      expect(unauthBody.error.code).toBe("E_UNAUTHORIZED");
    },
    120000,
  );

  it(
    "rejects dangerous contextDir values and accepts the sandboxed fixture",
    async () => {
      // /etc lives outside the build sandbox (PODKIT_BUILDS_ROOT = tmpdir) and
      // is a system directory either way: must be rejected with 400 E_BAD_ARGS.
      // Validation runs before project lookup, so an unknown slug still 400s.
      const etcRes = await fetch(apiUrl + "/v1/projects/sec-demo/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ contextDir: "/etc", containerPort: 3000 }),
      });
      expect(etcRes.status).toBe(400);
      const etcBody = await etcRes.json();
      expect(etcBody.ok).toBe(false);
      expect(etcBody.error.code).toBe("E_BAD_ARGS");

      // /var: another system directory outside the sandbox.
      const varRes = await fetch(apiUrl + "/v1/projects/sec-demo/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ contextDir: "/var", containerPort: 3000 }),
      });
      expect(varRes.status).toBe(400);
      const varBody = await varRes.json();
      expect(varBody.error.code).toBe("E_BAD_ARGS");

      // Non-existent path: realpath fails -> rejected with a clear message.
      const noexistRes = await fetch(apiUrl + "/v1/projects/sec-demo/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({
          contextDir: join(tmpdir(), "does-not-exist-12345abcde"),
          containerPort: 3000,
        }),
      });
      expect(noexistRes.status).toBe(400);
      const noexistBody = await noexistRes.json();
      expect(noexistBody.error.code).toBe("E_BAD_ARGS");
      expect(noexistBody.error.message).toContain("does not exist");

      // The existing tmp fixture (under PODKIT_BUILDS_ROOT) still deploys.
      await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ slug: "secok", owner: "me" }),
      });
      const validRes = await fetch(apiUrl + "/v1/projects/secok/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ contextDir: fixtureDir, containerPort: 3000 }),
      });
      expect(validRes.status).toBe(200);
      const validBody = await validRes.json();
      expect(validBody.ok).toBe(true);
    },
    120000,
  );
});
