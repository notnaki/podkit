import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("runContainer resource limits (arg-level)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // Stub node:child_process so runContainer never touches real docker; instead we
  // capture the argv it passes to `docker run` and assert the resource limits.
  async function captureRunArgs(
    opts: Parameters<typeof runContainer>[0],
  ): Promise<string[]> {
    const calls: { cmd: string; args: string[] }[] = [];

    // Reset the module registry so the dynamic import below re-evaluates docker.ts
    // against the freshly registered mock instead of a cached (real) module.
    vi.resetModules();

    vi.doMock("node:child_process", () => ({
      execFile: (
        cmd: string,
        args: string[],
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push({ cmd, args });
        // `docker run` returns the container id on stdout; `docker port` returns a host:port line.
        const stdout = args[0] === "run" ? "deadbeef\n" : "0.0.0.0:54321\n";
        cb(null, { stdout, stderr: "" });
      },
    }));

    const { runContainer: runContainerMocked } = await import("../src/docker.ts");
    await runContainerMocked(opts);

    const runCall = calls.find((c) => c.args[0] === "run");
    if (!runCall) {
      throw new Error("docker run was never invoked");
    }
    return runCall.args;
  }

  it("includes default cpu/memory/process limits in docker run argv", async () => {
    const args = await captureRunArgs({
      image: "podkit-rt-test:latest",
      name: "podkit-rt-defaults",
      containerPort: 8080,
    });

    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toBe("512m");

    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--cpus") + 1]).toBe("0.5");

    expect(args).toContain("--pids-limit");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("512");

    expect(args).toContain("--ulimit");
    expect(args[args.indexOf("--ulimit") + 1]).toBe("nofile=1024:1024");
  });

  it("lets opts.memory override the default memory limit", async () => {
    const args = await captureRunArgs({
      image: "podkit-rt-test:latest",
      name: "podkit-rt-override",
      containerPort: 8080,
      memory: "256m",
    });

    expect(args[args.indexOf("--memory") + 1]).toBe("256m");
    // Other defaults remain intact.
    expect(args[args.indexOf("--cpus") + 1]).toBe("0.5");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("512");
  });
});
