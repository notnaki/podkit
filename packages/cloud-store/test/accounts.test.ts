import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createStore } from "../src/index.ts";
import type { Store } from "../src/index.ts";

const containerName = `podkit-accounts-${randomBytes(4).toString("hex")}`;

function docker(args: Array<string>): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

let store: Store;

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

  const connectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;
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
    throw new Error(`Postgres not reachable after retries: ${String(lastErr)}`);
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

describe("cloud-store accounts + cli sessions", () => {
  it(
    "persists accounts in real Postgres",
    async () => {
      const email = `user-${randomBytes(4).toString("hex")}@example.com`;
      const passwordHash = `hash-${randomBytes(8).toString("hex")}`;

      const created = await store.createAccount({ email, passwordHash });
      expect(created.id).toBeTruthy();
      expect(created.email).toBe(email);

      const byEmail = await store.getAccountByEmail(email);
      expect(byEmail).not.toBeNull();
      expect(byEmail?.id).toBe(created.id);
      expect(byEmail?.email).toBe(email);
      expect(byEmail?.passwordHash).toBe(passwordHash);

      const byId = await store.getAccountById(created.id);
      expect(byId).not.toBeNull();
      expect(byId?.id).toBe(created.id);
      expect(byId?.email).toBe(email);

      const missingEmail = await store.getAccountByEmail(
        "nobody@example.com",
      );
      expect(missingEmail).toBeNull();

      await expect(
        store.createAccount({ email, passwordHash: "other-hash" }),
      ).rejects.toThrow();
    },
    60000,
  );

  it(
    "creates and approves CLI auth sessions in real Postgres",
    async () => {
      const email = `cli-${randomBytes(4).toString("hex")}@example.com`;
      const account = await store.createAccount({
        email,
        passwordHash: `hash-${randomBytes(8).toString("hex")}`,
      });

      const deviceCode = `dev-${randomBytes(8).toString("hex")}`;
      const userCode = `usr-${randomBytes(4).toString("hex")}`;

      const session = await store.createCliSession({ deviceCode, userCode });
      expect(session.id).toBeTruthy();

      const pending = await store.getCliSessionByDeviceCode(deviceCode);
      expect(pending).not.toBeNull();
      expect(pending?.id).toBe(session.id);
      expect(pending?.status).toBe("pending");
      expect(pending?.token).toBeNull();

      const token = `tok-${randomBytes(16).toString("hex")}`;
      await store.approveCliSession({
        userCode,
        accountId: account.id,
        token,
      });

      const approvedByDevice = await store.getCliSessionByDeviceCode(
        deviceCode,
      );
      expect(approvedByDevice).not.toBeNull();
      expect(approvedByDevice?.status).toBe("approved");
      expect(approvedByDevice?.token).toBe(token);

      const approvedByUser = await store.getCliSessionByUserCode(userCode);
      expect(approvedByUser).not.toBeNull();
      expect(approvedByUser?.id).toBe(session.id);
      expect(approvedByUser?.status).toBe("approved");

      const missing = await store.getCliSessionByDeviceCode("no-such-device");
      expect(missing).toBeNull();
    },
    60000,
  );
});
