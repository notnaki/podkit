import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createStore } from "../src/index.ts";
import type { Store } from "../src/index.ts";

const containerName = `podkit-store-env-${randomBytes(4).toString("hex")}`;

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
  const hostPort = portLine.split("\n")[0].split(":").pop();
  if (!hostPort) {
    throw new Error(`could not parse host port from: ${portLine}`);
  }

  const connectionString = `postgres://postgres:pk@localhost:${hostPort}/postgres`;
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
