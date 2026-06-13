import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { buildImage, containerLogs, runContainer, stopContainer } from "../src/index.ts";

const execFileAsync = promisify(execFile);

const DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
EXPOSE 8080
CMD ["node","server.mjs"]
`;

const SERVER_MJS = `import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("podkit-runtime-ok");
});
server.listen(8080, () => {
  console.log("listening on 8080");
});
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBuildContext(): string {
  const dir = mkdtempSync(join(tmpdir(), "podkit-rt-"));
  writeFileSync(join(dir, "Dockerfile"), DOCKERFILE);
  writeFileSync(join(dir, "server.mjs"), SERVER_MJS);
  return dir;
}

async function removeImage(tag: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rmi", "-f", tag]);
  } catch {
    // Ignore: image may not exist.
  }
}

describe("docker runtime", () => {
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
    "builds an image, runs a container, and serves over the published host port",
    async () => {
      const suffix = randomBytes(4).toString("hex");
      const tag = `podkit-rt-test:${suffix}`;
      const name = `podkit-rt-${suffix}`;
      const contextDir = createBuildContext();

      imageTags.push(tag);

      const built = await buildImage({ contextDir, tag });
      expect(built.tag).toBe(tag);

      const { id, hostPort } = await runContainer({
        image: tag,
        name,
        containerPort: 8080,
      });
      containerNames.push(name);

      expect(id).toMatch(/^[0-9a-f]+$/);
      expect(hostPort).toBeGreaterThan(0);

      let body: string | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await fetch(`http://localhost:${hostPort}`);
          if (res.ok) {
            body = await res.text();
            if (body.includes("podkit-runtime-ok")) {
              break;
            }
          }
        } catch {
          // Container not ready yet.
        }
        await sleep(500);
      }

      if (body === undefined || !body.includes("podkit-runtime-ok")) {
        const logs = await containerLogs(name);
        throw new Error(
          `Container did not respond as expected. Last body: ${JSON.stringify(body)}\nLogs:\n${logs}`,
        );
      }

      expect(body).toContain("podkit-runtime-ok");
    },
    60000,
  );
});
