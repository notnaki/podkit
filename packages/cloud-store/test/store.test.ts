import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { createStore } from "../src/index.ts";
import type { Store } from "../src/index.ts";

const containerName = `podkit-store-${randomBytes(4).toString("hex")}`;

function docker(args: Array<string>): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

let store: Store;
let connectionString: string;

beforeAll(async () => {
  docker([
    "run",
    "-d",
    "--rm",
    "--label",
    "podkit.test=1",
    "--name",
    containerName,
    "-e",
    "POSTGRES_PASSWORD=pk",
    "-p",
    "0:5432",
    "postgres:16-alpine",
  ]);

  const portLine = docker(["port", containerName, "5432"]);
  // e.g. "0.0.0.0:54321" or "[::]:54321"
  const hostPort = portLine.split("\n")[0].split(":").pop();
  if (!hostPort) {
    throw new Error(`could not parse host port from: ${portLine}`);
  }

  connectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;
  store = createStore({ connectionString });

  // Poll for readiness: ~30 attempts, 500ms apart.
  let ready = false;
  let lastErr: unknown = null;
  for (let i = 0; i < 30; i++) {
    try {
      await store.migrate();
      ready = true;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) {
    throw new Error(
      `Postgres not reachable after retries: ${String(lastErr)}`,
    );
  }
}, 60000);

afterAll(async () => {
  try {
    if (store) await store.close();
  } catch {
    // ignore
  }
  try {
    docker(["rm", "-f", containerName]);
  } catch {
    // ignore
  }
}, 60000);

describe("cloud-store", () => {
  it(
    "persists projects and deployments in real Postgres",
    async () => {
      const slug = `proj-${randomBytes(3).toString("hex")}`;

      const created = await store.createProject({
        slug,
        owner: "jr.nuhnaci@gmail.com",
      });
      expect(created.id).toBeTruthy();
      expect(created.slug).toBe(slug);

      const projects = await store.listProjects();
      const found = projects.find((p) => p.slug === slug);
      expect(found).toBeDefined();
      expect(found?.owner).toBe("jr.nuhnaci@gmail.com");
      expect(found?.id).toBe(created.id);

      const bySlug = await store.getProjectBySlug(slug);
      expect(bySlug).not.toBeNull();
      expect(bySlug?.id).toBe(created.id);
      expect(bySlug?.slug).toBe(slug);

      const missing = await store.getProjectBySlug("does-not-exist");
      expect(missing).toBeNull();

      const dep = await store.recordDeployment({
        projectId: created.id,
        version: "1.0.0",
        containerId: "abc123",
        hostPort: 8080,
        status: "running",
      });
      expect(dep.id).toBeTruthy();

      const deployments = await store.listDeployments(created.id);
      expect(deployments.length).toBe(1);
      expect(deployments[0].id).toBe(dep.id);
      expect(deployments[0].version).toBe("1.0.0");
      expect(deployments[0].hostPort).toBe(8080);
      expect(deployments[0].status).toBe("running");
    },
    60000,
  );

  it(
    "cli session expiry: expired session reports expired=true and approveCliSession returns false",
    async () => {
      const deviceCode = randomBytes(16).toString("hex");
      const userCode = randomBytes(4).toString("hex");

      // Create a fresh session (expires in 10 minutes by default).
      await store.createCliSession({ deviceCode, userCode });

      // Verify it is not yet expired.
      const fresh = await store.getCliSessionByDeviceCode(deviceCode);
      expect(fresh).not.toBeNull();
      expect(fresh!.expired).toBe(false);
      expect(fresh!.status).toBe("pending");

      // Verify a fresh session can be approved.
      const deviceCode2 = randomBytes(16).toString("hex");
      const userCode2 = randomBytes(4).toString("hex");
      await store.createCliSession({ deviceCode: deviceCode2, userCode: userCode2 });
      const approveOk = await store.approveCliSession({
        userCode: userCode2,
        accountId: "00000000-0000-0000-0000-000000000001",
        token: "tok-fresh",
      });
      expect(approveOk).toBe(true);

      // Expire the first session by backdating expires_at via a raw pg Client.
      const pg = new Client({ connectionString });
      await pg.connect();
      await pg.query(
        `UPDATE cli_auth_sessions SET expires_at = now() - interval '1 minute'
         WHERE device_code = $1`,
        [deviceCode],
      );
      await pg.end();

      // Now the session should report expired=true.
      const expired = await store.getCliSessionByDeviceCode(deviceCode);
      expect(expired).not.toBeNull();
      expect(expired!.expired).toBe(true);

      // approveCliSession should return false for an expired session.
      const approveExpired = await store.approveCliSession({
        userCode,
        accountId: "00000000-0000-0000-0000-000000000002",
        token: "tok-should-not-be-set",
      });
      expect(approveExpired).toBe(false);
    },
    60000,
  );
});
