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
  pgContainer = "podkit-auth-" + randomBytes(8).toString("hex");
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
  // NOTE: we intentionally do NOT assert a global "zero podkit.test containers"
  // here — cloud.close() stops app containers asynchronously (--rm self-removal
  // races this hook), and a global label check would also catch other suites'
  // containers when tests run concurrently. close() owns this suite's cleanup.
}, 120000);

describe("cloud-host account auth + CLI device flow (real Docker + Postgres)", () => {
  it(
    "signs up, logs in, runs the device flow, and authorizes mutations via a user Bearer token",
    async () => {
      // --- SIGNUP ---
      const signupRes = await fetch(apiUrl + "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "pw123456" }),
      });
      expect(signupRes.status).toBe(200);
      const signupBody = await signupRes.json();
      expect(signupBody.ok).toBe(true);
      const t1 = signupBody.data.token as string;
      expect(typeof t1).toBe("string");
      expect(signupBody.data.account.email).toBe("a@b.com");

      // --- ME ---
      const meRes = await fetch(apiUrl + "/v1/auth/me", {
        headers: { authorization: "Bearer " + t1 },
      });
      expect(meRes.status).toBe(200);
      const meBody = await meRes.json();
      expect(meBody.ok).toBe(true);
      expect(meBody.data.account.email).toBe("a@b.com");

      // --- LOGIN (correct) ---
      const loginRes = await fetch(apiUrl + "/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "pw123456" }),
      });
      expect(loginRes.status).toBe(200);
      const loginBody = await loginRes.json();
      expect(loginBody.ok).toBe(true);
      expect(typeof loginBody.data.token).toBe("string");

      // --- LOGIN (wrong password) ---
      const badLoginRes = await fetch(apiUrl + "/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "wrong" }),
      });
      expect(badLoginRes.status).toBe(401);
      const badLoginBody = await badLoginRes.json();
      expect(badLoginBody.ok).toBe(false);
      expect(badLoginBody.error.code).toBe("E_UNAUTHORIZED");

      // --- DEVICE FLOW: start ---
      const startRes = await fetch(apiUrl + "/v1/auth/cli/start", {
        method: "POST",
      });
      expect(startRes.status).toBe(200);
      const startBody = await startRes.json();
      expect(startBody.ok).toBe(true);
      const deviceCode = startBody.data.deviceCode as string;
      const userCode = startBody.data.userCode as string;
      expect(typeof deviceCode).toBe("string");
      expect(typeof userCode).toBe("string");
      // verifyUrl must NOT contain a pre-filled code (anti-phishing)
      expect(startBody.data.verifyUrl).not.toContain("?code=");
      expect(startBody.data.verifyUrl).toContain("/#/cli");

      // --- poll: pending ---
      const pollPendingRes = await fetch(apiUrl + "/v1/auth/cli/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      expect(pollPendingRes.status).toBe(200);
      const pollPendingBody = await pollPendingRes.json();
      expect(pollPendingBody.ok).toBe(true);
      expect(pollPendingBody.data.status).toBe("pending");

      // --- approve WITHOUT Bearer -> 401 ---
      const approveNoAuthRes = await fetch(apiUrl + "/v1/auth/cli/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
      });
      expect(approveNoAuthRes.status).toBe(401);

      // --- approve WITH Bearer T1 -> ok ---
      const approveRes = await fetch(apiUrl + "/v1/auth/cli/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + t1,
        },
        body: JSON.stringify({ userCode }),
      });
      expect(approveRes.status).toBe(200);
      const approveBody = await approveRes.json();
      expect(approveBody.ok).toBe(true);
      expect(approveBody.data.approved).toBe(true);

      // --- poll again: approved + token T2 ---
      const pollApprovedRes = await fetch(apiUrl + "/v1/auth/cli/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      expect(pollApprovedRes.status).toBe(200);
      const pollApprovedBody = await pollApprovedRes.json();
      expect(pollApprovedBody.ok).toBe(true);
      expect(pollApprovedBody.data.status).toBe("approved");
      const t2 = pollApprovedBody.data.token as string;
      expect(typeof t2).toBe("string");

      // --- GUARD: create project WITHOUT auth -> 401 ---
      const noAuthCreate = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "viab", owner: "a" }),
      });
      expect(noAuthCreate.status).toBe(401);
      const noAuthCreateBody = await noAuthCreate.json();
      expect(noAuthCreateBody.error.code).toBe("E_UNAUTHORIZED");

      // --- GUARD: create project WITH CLI Bearer T2 (no api key) -> ok ---
      const bearerCreate = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + t2,
        },
        body: JSON.stringify({ slug: "viab", owner: "a" }),
      });
      expect(bearerCreate.status).toBe(200);
      const bearerCreateBody = await bearerCreate.json();
      expect(bearerCreateBody.ok).toBe(true);
      expect(bearerCreateBody.data.project.slug).toBe("viab");
    },
    120000,
  );

  it(
    "signup rejects passwords shorter than 8 characters",
    async () => {
      const shortPwRes = await fetch(apiUrl + "/v1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "short@b.com", password: "abc" }),
      });
      expect(shortPwRes.status).toBe(400);
      const shortPwBody = await shortPwRes.json();
      expect(shortPwBody.ok).toBe(false);
      expect(shortPwBody.error.code).toBe("E_BAD_ARGS");
      expect(shortPwBody.error.message).toMatch(/8 characters/);
    },
    120000,
  );

  it(
    "deploy rejects unsafe appSubpath values",
    async () => {
      // First create a project to deploy against (using the api key).
      const slug = `sec-${randomBytes(3).toString("hex")}`;
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-podkit-key": "k",
        },
        body: JSON.stringify({ slug, owner: "test" }),
      });
      expect(createRes.status).toBe(200);

      // Send deploy with a path-traversal appSubpath.
      const deployRes = await fetch(apiUrl + `/v1/projects/${slug}/deploy`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-podkit-key": "k",
        },
        body: JSON.stringify({
          contextDir: "/tmp",
          containerPort: 3000,
          appSubpath: "../etc",
        }),
      });
      expect(deployRes.status).toBe(400);
      const deployBody = await deployRes.json();
      expect(deployBody.ok).toBe(false);
      expect(deployBody.error.code).toBe("E_BAD_ARGS");
      expect(deployBody.error.message).toMatch(/appSubpath/);
    },
    120000,
  );

  it(
    "poll returns expired status for backdated session",
    async () => {
      // Start a new CLI session.
      const startRes = await fetch(apiUrl + "/v1/auth/cli/start", {
        method: "POST",
      });
      expect(startRes.status).toBe(200);
      const startBody = await startRes.json();
      const deviceCode = startBody.data.deviceCode as string;

      // Backdate the session via raw SQL.
      const pg = new Client({ connectionString });
      await pg.connect();
      await pg.query(
        `UPDATE cli_auth_sessions SET expires_at = now() - interval '1 minute'
         WHERE device_code = $1`,
        [deviceCode],
      );
      await pg.end();

      // Poll should now return expired status.
      const pollRes = await fetch(apiUrl + "/v1/auth/cli/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      expect(pollRes.status).toBe(200);
      const pollBody = await pollRes.json();
      expect(pollBody.ok).toBe(true);
      expect(pollBody.data.status).toBe("expired");
    },
    120000,
  );
});
