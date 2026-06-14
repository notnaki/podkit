import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { createStore } from "../src/index.ts";
import type { Store } from "../src/index.ts";
import { encryptValue, decryptValue } from "../src/crypto.ts";
import { resolveSecretsKey } from "@podkit/auth";

const containerName = `podkit-store-env-${randomBytes(4).toString("hex")}`;

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
  const hostPort = portLine.split("\n")[0].split(":").pop();
  if (!hostPort) {
    throw new Error(`could not parse host port from: ${portLine}`);
  }

  connectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;
  store = createStore({ connectionString });

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

describe("cloud-store project env", () => {
  it(
    "setEnv inserts then upserts, listEnv returns full sorted values, deleteEnv removes",
    async () => {
      const slug = `proj-${randomBytes(3).toString("hex")}`;
      const project = await store.createProject({
        slug,
        owner: "jr.nuhnaci@gmail.com",
      });

      // Insert two vars (out of alpha order to prove sorting).
      await store.setEnv({
        projectId: project.id,
        key: "ZED",
        value: "z1",
        sensitive: false,
      });
      await store.setEnv({
        projectId: project.id,
        key: "API_KEY",
        value: "secret1",
        sensitive: true,
      });

      let env = await store.listEnv(project.id);
      expect(env.length).toBe(2);
      // Sorted by key ascending.
      expect(env.map((e) => e.key)).toEqual(["API_KEY", "ZED"]);
      // Full values returned.
      expect(env[0]).toEqual({ key: "API_KEY", value: "secret1", sensitive: true });
      expect(env[1]).toEqual({ key: "ZED", value: "z1", sensitive: false });

      // Upsert-overwrite: same key, new value + flipped sensitive.
      await store.setEnv({
        projectId: project.id,
        key: "API_KEY",
        value: "secret2",
        sensitive: false,
      });
      env = await store.listEnv(project.id);
      expect(env.length).toBe(2);
      const apiKey = env.find((e) => e.key === "API_KEY");
      expect(apiKey).toEqual({ key: "API_KEY", value: "secret2", sensitive: false });

      // Delete one.
      await store.deleteEnv({ projectId: project.id, key: "API_KEY" });
      env = await store.listEnv(project.id);
      expect(env.length).toBe(1);
      expect(env[0].key).toBe("ZED");

      // Deleting a missing key is a no-op.
      await store.deleteEnv({ projectId: project.id, key: "NOPE" });
      env = await store.listEnv(project.id);
      expect(env.length).toBe(1);
    },
    60000,
  );
});

describe("cloud-store project env encryption", () => {
  const KEY_HEX = randomBytes(32).toString("hex");

  function withKey<T>(fn: () => T): T {
    const prev = process.env.PODKIT_SECRETS_KEY;
    process.env.PODKIT_SECRETS_KEY = KEY_HEX;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.PODKIT_SECRETS_KEY;
      else process.env.PODKIT_SECRETS_KEY = prev;
    }
  }

  it(
    "encrypts sensitive values at rest when key available and decrypts on read",
    async () => {
      const encStore = withKey(() => createStore({ connectionString }));
      try {
        const project = await encStore.createProject({
          slug: `proj-${randomBytes(3).toString("hex")}`,
          owner: "jr.nuhnaci@gmail.com",
        });

        await encStore.setEnv({
          projectId: project.id,
          key: "API_KEY",
          value: "secret-token-12345",
          sensitive: true,
        });

        // Round-trip via the store returns plaintext.
        const env = await encStore.listEnv(project.id);
        const apiKey = env.find((e) => e.key === "API_KEY");
        expect(apiKey?.value).toBe("secret-token-12345");

        // At rest the raw column is ciphertext, not plaintext.
        const pool = new Pool({ connectionString });
        try {
          const raw = await pool.query<{ value: string }>(
            "SELECT value FROM project_env WHERE project_id = $1 AND key = $2",
            [project.id, "API_KEY"],
          );
          expect(raw.rows[0].value.startsWith("enc:v1:")).toBe(true);
          expect(raw.rows[0].value).not.toContain("secret-token-12345");
        } finally {
          await pool.end();
        }
      } finally {
        await encStore.close();
      }
    },
    60000,
  );

  it(
    "backward-compat: reads legacy plaintext rows not prefixed with enc:v1:",
    async () => {
      const encStore = withKey(() => createStore({ connectionString }));
      const pool = new Pool({ connectionString });
      try {
        const project = await encStore.createProject({
          slug: `proj-${randomBytes(3).toString("hex")}`,
          owner: "jr.nuhnaci@gmail.com",
        });

        // Direct insert bypasses encryption, simulating a legacy row.
        await pool.query(
          "INSERT INTO project_env (project_id, key, value, sensitive) VALUES ($1, $2, $3, $4)",
          [project.id, "LEGACY_VAR", "plaintext-value", false],
        );

        const env = await encStore.listEnv(project.id);
        const legacy = env.find((e) => e.key === "LEGACY_VAR");
        expect(legacy?.value).toBe("plaintext-value");
      } finally {
        await pool.end();
        await encStore.close();
      }
    },
    60000,
  );

  it("crypto round-trips and passes through legacy plaintext / wrong key", () => {
    const key = randomBytes(32);
    const enc = encryptValue("hello-world", key);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptValue(enc, key)).toBe("hello-world");

    // Non-prefixed values pass through unchanged.
    expect(decryptValue("plain", key)).toBe("plain");

    // Wrong key degrades gracefully (returns stored value, no throw).
    const otherKey = randomBytes(32);
    expect(decryptValue(enc, otherKey)).toBe(enc);
  });

  it("resolveSecretsKey validates key format and dev fallback", () => {
    const prev = process.env.PODKIT_SECRETS_KEY;
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      // Valid 64-hex key resolves to a 32-byte buffer.
      process.env.PODKIT_SECRETS_KEY = "a".repeat(64);
      const key = resolveSecretsKey();
      expect(key).not.toBeNull();
      expect(key?.length).toBe(32);

      // Invalid length throws.
      process.env.PODKIT_SECRETS_KEY = "deadbeef";
      expect(() => resolveSecretsKey()).toThrow();

      // Unset in non-production returns null (encryption disabled).
      delete process.env.PODKIT_SECRETS_KEY;
      process.env.NODE_ENV = "test";
      expect(resolveSecretsKey()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.PODKIT_SECRETS_KEY;
      else process.env.PODKIT_SECRETS_KEY = prev;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
