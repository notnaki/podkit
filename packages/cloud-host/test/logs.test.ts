import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { containerLogs } from "@podkit/runtime";
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
      // Emit several distinct lines on boot so ?limit can be exercised.
      `console.log(${JSON.stringify(marker)} + "-1");`,
      `console.log(${JSON.stringify(marker)} + "-2");`,
      `console.log(${JSON.stringify(marker)} + "-3");`,
      `console.log(${JSON.stringify(marker)} + "-4");`,
      `console.log(${JSON.stringify(marker)} + "-5");`,
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
  // Remove images this suite built (slug lg), best-effort.
  await cleanupImages("podkit-lg:v");
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

      const countNonEmpty = (s: string) =>
        s.split("\n").filter((l) => l.trim().length > 0).length;

      // (e) regression: no-params GET still returns the full set of log lines.
      const full = await (
        await fetch(apiUrl + "/v1/projects/lg/logs", { headers: keyHeader })
      ).json();
      expect(full.ok).toBe(true);
      expect(countNonEmpty(full.data.logs as string)).toBeGreaterThanOrEqual(5);

      // (a) ?limit=2 -> at most 2 non-empty lines returned.
      const limited = await (
        await fetch(apiUrl + "/v1/projects/lg/logs?limit=2", {
          headers: keyHeader,
        })
      ).json();
      expect(limited.ok).toBe(true);
      expect(countNonEmpty(limited.data.logs as string)).toBeLessThanOrEqual(2);

      // (b) out-of-range / non-integer limits -> 400 E_BAD_ARGS.
      for (const bad of ["0", "99999", "-1", "abc", "1.5"]) {
        const res = await fetch(
          apiUrl + "/v1/projects/lg/logs?limit=" + bad,
          { headers: keyHeader },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe("E_BAD_ARGS");
      }

      // (c) ?since=not-a-date -> 400 E_BAD_ARGS.
      const badSince = await fetch(
        apiUrl + "/v1/projects/lg/logs?since=not-a-date",
        { headers: keyHeader },
      );
      expect(badSince.status).toBe(400);
      const badSinceBody = await badSince.json();
      expect(badSinceBody.ok).toBe(false);
      expect(badSinceBody.error.code).toBe("E_BAD_ARGS");

      // (d) ?since=<valid ISO> -> 200, no crash.
      const okSince = await fetch(
        apiUrl + "/v1/projects/lg/logs?since=2000-01-01T00:00:00Z",
        { headers: keyHeader },
      );
      expect(okSince.status).toBe(200);
      const okSinceBody = await okSince.json();
      expect(okSinceBody.ok).toBe(true);

      // authz: a non-owner bearer is forbidden (403) regardless of params.
      const reg = await fetch(apiUrl + "/v1/auth/signup", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "intruder-" + randomBytes(4).toString("hex") + "@example.com",
          password: "password123",
        }),
      });
      const regBody = await reg.json();
      expect(regBody.ok).toBe(true);
      const intruderToken = regBody.data.token as string;
      const forbidden = await fetch(
        apiUrl + "/v1/projects/lg/logs?limit=2",
        { headers: { authorization: "Bearer " + intruderToken } },
      );
      expect(forbidden.status).toBe(403);
    },
    240000,
  );

  it("containerLogs builds the expected argv for tail/since", async () => {
    // Hitting a name that does not exist; we only care about the argv docker
    // was invoked with, captured via the error message docker emits.
    const name = "podkit-no-such-" + randomBytes(4).toString("hex");
    let err: unknown = null;
    try {
      await containerLogs(name, { tail: 5, since: "2026-06-14T00:00:00Z" });
    } catch (e) {
      err = e;
    }
    // execFile surfaces the full argv on its error object.
    const cmd = String((err as { cmd?: string })?.cmd ?? err);
    expect(cmd).toContain("logs");
    expect(cmd).toContain("--tail");
    expect(cmd).toContain("5");
    expect(cmd).toContain("--since");
    expect(cmd).toContain("2026-06-14T00:00:00Z");
    expect(cmd).toContain(name);

    // No opts -> bare `docker logs <name>`, no --tail/--since.
    let err2: unknown = null;
    try {
      await containerLogs(name);
    } catch (e) {
      err2 = e;
    }
    const cmd2 = String((err2 as { cmd?: string })?.cmd ?? err2);
    expect(cmd2).not.toContain("--tail");
    expect(cmd2).not.toContain("--since");
  });
});
