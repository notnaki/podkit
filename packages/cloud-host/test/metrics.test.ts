import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { createMetricsRegistry } from "@podkit/telemetry";
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

// Best-effort, non-fatal cleanup of Docker images this suite built.
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
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// Build a fixture app that returns the status code requested via ?status=NNN
// (default 200), so the test can drive a deterministic mix of status classes
// through the gateway and assert the recorded buckets.
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "podkit-mx-"));
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
      "createServer((req, res) => {",
      '  const u = new URL(req.url, "http://x");',
      '  const status = Number(u.searchParams.get("status")) || 200;',
      '  res.writeHead(status, { "content-type": "text/plain" });',
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
      const res = await fetch(gatewayUrl + "/_p/mx/");
      if ((await res.text()) === "ok") return;
    } catch {
      // ignore
    }
    await sleep(1000);
  }
  throw new Error("gateway never served the app");
}

beforeAll(async () => {
  pgContainer = "podkit-mx-cp-" + randomBytes(4).toString("hex");
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
      database: "proj_mx",
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
  await cleanupImages("podkit-mx:v");
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
    .filter((n) => n === pgContainer || n.startsWith("podkit-app-mx-"));
  expect(leftover).toEqual([]);
}, 120000);

describe("per-project request metrics registry (unit)", () => {
  it("buckets statuses by class and averages latency", () => {
    const registry = createMetricsRegistry();
    expect(registry.snapshot("a")).toBeNull();

    const latencies = [10, 20, 30, 40, 50];
    registry.record({ slug: "a", statusCode: 200, latencyMs: latencies[0]! });
    registry.record({ slug: "a", statusCode: 200, latencyMs: latencies[1]! });
    registry.record({ slug: "a", statusCode: 404, latencyMs: latencies[2]! });
    registry.record({ slug: "a", statusCode: 500, latencyMs: latencies[3]! });
    registry.record({ slug: "a", statusCode: 302, latencyMs: latencies[4]! });

    const snap = registry.snapshot("a")!;
    expect(snap.requests).toBe(5);
    expect(snap.status2xx).toBe(2);
    expect(snap.status3xx).toBe(1);
    expect(snap.status4xx).toBe(1);
    expect(snap.status5xx).toBe(1);
    const mean = latencies.reduce((sum, n) => sum + n, 0) / latencies.length;
    expect(snap.avgLatencyMs).toBe(mean);
    expect(snap.lastSeen).toBeGreaterThan(0);

    // Slugs are isolated.
    expect(registry.snapshot("b")).toBeNull();
  });
});

describe("cloud-host metrics endpoint (real Docker + Postgres)", () => {
  it(
    "is ownership-gated and reports gateway-collected counts",
    async () => {
      // Owner account.
      const ownerSignup = await (
        await fetch(apiUrl + "/v1/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "owner-mx@example.com",
            password: "password123",
          }),
        })
      ).json();
      expect(ownerSignup.ok).toBe(true);
      const ownerToken = ownerSignup.data.token as string;
      const ownerAuth = {
        "content-type": "application/json",
        authorization: "Bearer " + ownerToken,
      };

      // Second (non-owner) account.
      const otherSignup = await (
        await fetch(apiUrl + "/v1/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "other-mx@example.com",
            password: "password123",
          }),
        })
      ).json();
      expect(otherSignup.ok).toBe(true);
      const otherToken = otherSignup.data.token as string;

      // (d) No credentials -> 401 (existence not leaked via 404).
      const noAuth = await fetch(apiUrl + "/v1/projects/mx/metrics");
      expect(noAuth.status).toBe(401);
      expect((await noAuth.json()).error.code).toBe("E_UNAUTHORIZED");

      // Create + own the project (owner bound to the bearer account).
      const created = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: ownerAuth,
        body: JSON.stringify({ slug: "mx" }),
      });
      expect((await created.json()).ok).toBe(true);

      // (c) Second account -> 403 E_FORBIDDEN.
      const forbidden = await fetch(apiUrl + "/v1/projects/mx/metrics", {
        headers: { authorization: "Bearer " + otherToken },
      });
      expect(forbidden.status).toBe(403);
      expect((await forbidden.json()).error.code).toBe("E_FORBIDDEN");

      // Owner with no traffic yet -> zeroed snapshot.
      const zero = await (
        await fetch(apiUrl + "/v1/projects/mx/metrics", { headers: ownerAuth })
      ).json();
      expect(zero.ok).toBe(true);
      expect(zero.data.requests).toBe(0);

      // Deploy a fixture that echoes the requested status, then drive a known
      // mix of requests through the gateway so metrics are collected.
      const dir = makeFixture();
      const dep = await fetch(apiUrl + "/v1/projects/mx/deploy", {
        method: "POST",
        headers: ownerAuth,
        body: JSON.stringify({ contextDir: dir, containerPort: 3000 }),
      });
      expect((await dep.json()).ok).toBe(true);
      await waitServed();

      // Read the baseline (waitServed already generated some 2xx traffic).
      const baseline = await (
        await fetch(apiUrl + "/v1/projects/mx/metrics", { headers: ownerAuth })
      ).json();
      const base = baseline.data;

      // Drive a deterministic mix: 2x 200, 1x 302, 1x 404, 1x 500.
      const statuses = [200, 200, 302, 404, 500];
      for (const s of statuses) {
        await fetch(gatewayUrl + "/_p/mx/?status=" + s);
      }

      // Poll until the gateway-collected counts reflect our requests.
      let snap: {
        requests: number;
        status2xx: number;
        status3xx: number;
        status4xx: number;
        status5xx: number;
        avgLatencyMs: number;
      } | null = null;
      for (let i = 0; i < 20; i++) {
        const body = await (
          await fetch(apiUrl + "/v1/projects/mx/metrics", { headers: ownerAuth })
        ).json();
        if (body.data.requests >= base.requests + statuses.length) {
          snap = body.data;
          break;
        }
        await sleep(250);
      }
      expect(snap).not.toBeNull();
      expect(snap!.status2xx).toBe(base.status2xx + 2);
      expect(snap!.status3xx).toBe(base.status3xx + 1);
      expect(snap!.status4xx).toBe(base.status4xx + 1);
      expect(snap!.status5xx).toBe(base.status5xx + 1);
      expect(snap!.avgLatencyMs).toBeGreaterThanOrEqual(0);

      // Machine API key sees the project too (full access).
      const keySnap = await fetch(apiUrl + "/v1/projects/mx/metrics", {
        headers: { "x-podkit-key": "k" },
      });
      expect(keySnap.status).toBe(200);
    },
    240000,
  );
});
