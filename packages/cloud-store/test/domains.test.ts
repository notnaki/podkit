import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createStore } from "../src/index.ts";
import type { Store } from "../src/index.ts";

const containerName = `podkit-store-domains-${randomBytes(4).toString("hex")}`;

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

describe("cloud-store project domains", () => {
  it(
    "addDomain, listDomains (sorted), listAllDomains (with slug), deleteDomain",
    async () => {
      const slug = `proj-${randomBytes(3).toString("hex")}`;
      const project = await store.createProject({
        slug,
        owner: "jr.nuhnaci@gmail.com",
      });

      // Add two domains out of alpha order to prove sorting.
      await store.addDomain({ projectId: project.id, domain: "zed.example.com" });
      await store.addDomain({ projectId: project.id, domain: "app.example.com" });

      let domains = await store.listDomains(project.id);
      expect(domains).toEqual([
        { domain: "app.example.com" },
        { domain: "zed.example.com" },
      ]);

      // listAllDomains joins to projects and exposes the slug.
      const all = await store.listAllDomains();
      const mine = all.filter((d) => d.slug === slug);
      expect(mine).toEqual([
        { domain: "app.example.com", slug },
        { domain: "zed.example.com", slug },
      ]);

      // Delete one domain.
      await store.deleteDomain({
        projectId: project.id,
        domain: "app.example.com",
      });
      domains = await store.listDomains(project.id);
      expect(domains).toEqual([{ domain: "zed.example.com" }]);

      // Deleting a missing domain is a no-op.
      await store.deleteDomain({
        projectId: project.id,
        domain: "nope.example.com",
      });
      domains = await store.listDomains(project.id);
      expect(domains).toEqual([{ domain: "zed.example.com" }]);
    },
    60000,
  );
});
