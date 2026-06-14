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

// Decode the base64url JSON payload of a podkit token (body before the ".").
function decodePayload(token: string): Record<string, unknown> {
  const body = token.slice(0, token.indexOf("."));
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

beforeAll(async () => {
  pgContainer = "podkit-tokenlc-" + randomBytes(8).toString("hex");
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

async function signup(email: string): Promise<string> {
  const res = await fetch(apiUrl + "/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw123456" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.token as string;
}

describe("token lifecycle: TTL wiring + revocation (real Docker + Postgres)", () => {
  it(
    "issues account tokens with jti + 30-day exp",
    async () => {
      const token = await signup(`acct-${randomBytes(4).toString("hex")}@b.com`);
      const payload = decodePayload(token);
      expect(typeof payload["jti"]).toBe("string");
      expect(typeof payload["iat"]).toBe("number");
      expect(typeof payload["exp"]).toBe("number");
      const iat = payload["iat"] as number;
      const exp = payload["exp"] as number;
      expect(exp - iat).toBe(30 * 24 * 60 * 60);
    },
    120000,
  );

  it(
    "issues CLI tokens with jti + 90-day exp",
    async () => {
      const t1 = await signup(`cli-${randomBytes(4).toString("hex")}@b.com`);

      const startRes = await fetch(apiUrl + "/v1/auth/cli/start", {
        method: "POST",
      });
      const startBody = await startRes.json();
      const deviceCode = startBody.data.deviceCode as string;
      const userCode = startBody.data.userCode as string;

      const approveRes = await fetch(apiUrl + "/v1/auth/cli/approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + t1,
        },
        body: JSON.stringify({ userCode }),
      });
      expect(approveRes.status).toBe(200);

      const pollRes = await fetch(apiUrl + "/v1/auth/cli/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
      const pollBody = await pollRes.json();
      const cliToken = pollBody.data.token as string;
      const payload = decodePayload(cliToken);
      expect(typeof payload["jti"]).toBe("string");
      expect(payload["cli"]).toBe(true);
      const iat = payload["iat"] as number;
      const exp = payload["exp"] as number;
      expect(exp - iat).toBe(90 * 24 * 60 * 60);
    },
    120000,
  );

  it(
    "logout revokes a token so subsequent auth is rejected",
    async () => {
      const token = await signup(`out-${randomBytes(4).toString("hex")}@b.com`);

      // Token works before logout.
      const meBefore = await fetch(apiUrl + "/v1/auth/me", {
        headers: { authorization: "Bearer " + token },
      });
      expect(meBefore.status).toBe(200);

      // Logout revokes it.
      const logoutRes = await fetch(apiUrl + "/v1/auth/logout", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
      });
      expect(logoutRes.status).toBe(200);
      const logoutBody = await logoutRes.json();
      expect(logoutBody.ok).toBe(true);
      expect(logoutBody.data.revoked).toBe(true);

      // Token is now rejected.
      const meAfter = await fetch(apiUrl + "/v1/auth/me", {
        headers: { authorization: "Bearer " + token },
      });
      expect(meAfter.status).toBe(401);

      // Double logout is graceful (token no longer authenticates -> 401).
      const logoutAgain = await fetch(apiUrl + "/v1/auth/logout", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
      });
      expect(logoutAgain.status).toBe(401);
    },
    120000,
  );

  it(
    "logout requires a bearer token",
    async () => {
      const res = await fetch(apiUrl + "/v1/auth/logout", { method: "POST" });
      expect(res.status).toBe(401);
    },
    120000,
  );

  it(
    "old tokens without jti still authenticate and logout is a graceful no-op",
    async () => {
      // Craft a token the way pre-feature code did: no jti, no exp. We sign it
      // by replaying the host's signing scheme against an existing account.
      const email = `old-${randomBytes(4).toString("hex")}@b.com`;
      const newToken = await signup(email);
      const accountId = decodePayload(newToken)["accountId"] as string;

      const { signToken } = await import("@podkit/auth");
      const { resolveAuthSecret } = await import("@podkit/auth");
      const secret = resolveAuthSecret();
      const legacyToken = signToken({ accountId, email }, secret); // no jti, no ttl

      // Legacy token authenticates (jti check is skipped).
      const meRes = await fetch(apiUrl + "/v1/auth/me", {
        headers: { authorization: "Bearer " + legacyToken },
      });
      expect(meRes.status).toBe(200);

      // Logout on a jti-less token is a graceful no-op.
      const logoutRes = await fetch(apiUrl + "/v1/auth/logout", {
        method: "POST",
        headers: { authorization: "Bearer " + legacyToken },
      });
      expect(logoutRes.status).toBe(200);
      const logoutBody = await logoutRes.json();
      expect(logoutBody.data.revoked).toBe(false);

      // Still works afterwards (was never revocable).
      const meAfter = await fetch(apiUrl + "/v1/auth/me", {
        headers: { authorization: "Bearer " + legacyToken },
      });
      expect(meAfter.status).toBe(200);
    },
    120000,
  );
});
