import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { buildPodkitApp, containerLogs, runContainer, stopContainer } from "../src/index.ts";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeImage(tag: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rmi", "-f", tag]);
  } catch {
    // Ignore: image may not exist.
  }
}

describe("buildpack docker run", () => {
  const containerNames: string[] = [];
  const imageTags: string[] = [];

  afterEach(async () => {
    for (const name of containerNames.splice(0)) {
      await stopContainer(name);
    }
    for (const tag of imageTags.splice(0)) {
      await removeImage(tag);
    }
  });

  it(
    "builds the monorepo image and serves the podkit dev server",
    async () => {
      const suffix = randomBytes(4).toString("hex");
      const tag = `podkit-bp-test:${suffix}`;
      const name = `podkit-bp-${suffix}`;

      imageTags.push(tag);

      const { tag: builtTag, port } = await buildPodkitApp({
        repoRoot,
        appSubpath: "examples/hello",
        tag,
        port: 3000,
      });
      expect(builtTag).toBe(tag);

      const { id, hostPort } = await runContainer({
        image: tag,
        name,
        containerPort: port,
      });
      containerNames.push(name);

      expect(id).toMatch(/^[0-9a-f]+$/);
      expect(hostPort).toBeGreaterThan(0);

      let body: string | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const res = await fetch(`http://localhost:${hostPort}/`);
          if (res.ok) {
            body = await res.text();
            if (body.includes("podkit home")) {
              break;
            }
          }
        } catch {
          // Container not ready yet.
        }
        await sleep(2000);
      }

      if (body === undefined || !body.includes("podkit home")) {
        const logs = await containerLogs(name);
        throw new Error(
          `podkit dev server did not respond as expected. Last body: ${JSON.stringify(body)}\nLogs:\n${logs}`,
        );
      }

      expect(body).toContain("podkit home");
    },
    600000,
  );
});
