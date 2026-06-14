import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
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
  pgContainer = "podkit-cp-env-" + randomBytes(4).toString("hex");
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
  try {
    await dropDatabase({
      adminConnectionString: connectionString,
      database: "proj_envapp",
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
}, 120000);

describe("cloud-host project env vars (real Postgres)", () => {
  it(
    "POST/GET/DELETE env with masking, validation, and auth",
    async () => {
      const slug = "envapp";

      // Create the project.
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ slug, owner: "me" }),
      });
      expect(createRes.status).toBe(200);
      expect((await createRes.json()).ok).toBe(true);

      // POST a plain var.
      const plainRes = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ key: "PUBLIC_URL", value: "https://x.test", sensitive: false }),
      });
      expect(plainRes.status).toBe(200);
      const plainBody = await plainRes.json();
      expect(plainBody.ok).toBe(true);
      expect(plainBody.data.key).toBe("PUBLIC_URL");

      // POST a sensitive var.
      const secretRes = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ key: "DB_PASSWORD", value: "supersecret", sensitive: true }),
      });
      expect(secretRes.status).toBe(200);
      expect((await secretRes.json()).ok).toBe(true);

      // GET env: plain shows value, sensitive shows null + sensitive true.
      const listRes = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        headers: { "x-podkit-key": "k" },
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.ok).toBe(true);
      const env: Array<{ key: string; sensitive: boolean; value: string | null }> =
        listBody.data.env;
      const plain = env.find((e) => e.key === "PUBLIC_URL");
      const secret = env.find((e) => e.key === "DB_PASSWORD");
      expect(plain).toEqual({
        key: "PUBLIC_URL",
        sensitive: false,
        value: "https://x.test",
      });
      expect(secret).toEqual({
        key: "DB_PASSWORD",
        sensitive: true,
        value: null,
      });

      // Invalid key -> 400 E_BAD_ARGS.
      const badRes = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ key: "1BAD-KEY", value: "x", sensitive: false }),
      });
      expect(badRes.status).toBe(400);
      const badBody = await badRes.json();
      expect(badBody.ok).toBe(false);
      expect(badBody.error.code).toBe("E_BAD_ARGS");

      // DELETE removes the plain var.
      const delRes = await fetch(
        apiUrl + `/v1/projects/${slug}/env/PUBLIC_URL`,
        {
          method: "DELETE",
          headers: { "x-podkit-key": "k" },
        },
      );
      expect(delRes.status).toBe(200);
      const delBody = await delRes.json();
      expect(delBody.ok).toBe(true);
      expect(delBody.data.deleted).toBe("PUBLIC_URL");

      const afterDel = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        headers: { "x-podkit-key": "k" },
      });
      const afterBody = await afterDel.json();
      const remaining: Array<{ key: string }> = afterBody.data.env;
      expect(remaining.find((e) => e.key === "PUBLIC_URL")).toBeUndefined();
      expect(remaining.find((e) => e.key === "DB_PASSWORD")).toBeDefined();

      // Unauthenticated POST -> 401.
      const unauthRes = await fetch(apiUrl + `/v1/projects/${slug}/env`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "NOPE", value: "x", sensitive: false }),
      });
      expect(unauthRes.status).toBe(401);
      const unauthBody = await unauthRes.json();
      expect(unauthBody.ok).toBe(false);
      expect(unauthBody.error.code).toBe("E_UNAUTHORIZED");
    },
    120000,
  );
});
