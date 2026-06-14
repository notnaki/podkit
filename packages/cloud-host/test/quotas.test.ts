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
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";

async function waitForPostgres(connStr: string, attempts = 40): Promise<void> {
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
  throw new Error("Postgres not ready: " + String(lastErr));
}

async function signup(email: string): Promise<string> {
  const res = await fetch(apiUrl + "/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw12345678" }),
  });
  const body = await res.json();
  return body.data.token as string;
}

beforeAll(async () => {
  pgContainer = "podkit-quota-" + randomBytes(4).toString("hex");
  await execFileAsync("docker", [
    "run", "-d", "--rm", "--label", TEST_LABEL, "--name", pgContainer,
    "-e", "POSTGRES_PASSWORD=pk", "-p", "0:5432", "postgres:16-alpine",
  ]);
  const { stdout } = await execFileAsync("docker", ["port", pgContainer, "5432"]);
  const port = /:(\d+)\s*$/.exec(stdout.trim().split("\n")[0]!)![1]!;
  const conn = `postgres://postgres:pk@localhost:${port}/postgres`;
  await waitForPostgres(conn);

  cloud = createCloud({
    controlPlaneConnectionString: conn,
    adminConnectionString: conn,
    apiKey: "k",
    maxProjectsPerAccount: 3,
    rateLimitPerMin: 20,
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

describe("quotas + rate limiting (real Postgres)", () => {
  it(
    "enforces the per-account project quota",
    async () => {
      const token = await signup(`q-${randomBytes(3).toString("hex")}@x.dev`);
      const create = (slug: string) =>
        fetch(apiUrl + "/v1/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + token,
          },
          body: JSON.stringify({ slug }),
        });
      const sfx = randomBytes(3).toString("hex");
      for (let i = 0; i < 3; i++) {
        expect((await create(`qp-${sfx}-${i}`)).status).toBe(200);
      }
      const over = await create(`qp-${sfx}-3`);
      expect(over.status).toBe(403);
      const body = await over.json();
      expect(body.error.code).toBe("E_QUOTA");

      // The machine API key is exempt from the per-account quota.
      const keyCreate = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ slug: `qk-${sfx}` }),
      });
      expect(keyCreate.status).toBe(200);
    },
    120000,
  );

  it(
    "rate-limits the API per credential (429 over the window)",
    async () => {
      const token = await signup(`r-${randomBytes(3).toString("hex")}@x.dev`);
      // Limit is 20/min for this account's token; the read endpoint is cheap.
      let got429 = false;
      for (let i = 0; i < 25; i++) {
        const res = await fetch(apiUrl + "/v1/projects", {
          headers: { authorization: "Bearer " + token },
        });
        if (res.status === 429) {
          const body = await res.json();
          expect(body.error.code).toBe("E_RATE_LIMITED");
          got429 = true;
          break;
        }
      }
      expect(got429).toBe(true);
    },
    120000,
  );
});
