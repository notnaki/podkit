import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMPOSE_FILE = "/Users/nuh/Desktop/podkit-w3/infra/docker-compose.yml";
const project = "podkit-ci-" + randomBytes(4).toString("hex");

function compose(args: string[]) {
  return execFileAsync(
    "docker",
    ["compose", "-p", project, "-f", COMPOSE_FILE, ...args],
    { maxBuffer: 50 * 1024 * 1024 },
  );
}

async function captureLogs(): Promise<string> {
  try {
    const { stdout, stderr } = await compose(["logs", "--no-color"]);
    return stdout + "\n" + stderr;
  } catch (err) {
    return "could not capture logs: " + String(err);
  }
}

describe("podkit cloud boots via docker compose", () => {
  it(
    "comes up healthy and provisions a project end-to-end",
    async () => {
      let bootError: unknown = null;

      try {
        // Build + start the stack. Building the control-plane image is slow.
        await compose(["up", "-d", "--build"]);

        // Poll the control-plane health endpoint.
        let healthy = false;
        let lastErr: unknown = null;
        for (let i = 0; i < 60; i++) {
          try {
            const res = await fetch("http://localhost:8080/v1/health");
            if (res.ok) {
              const body = await res.json();
              // Health wraps payload in { ok: true, data: { status: "ok" } }.
              if (body && body.ok === true) {
                healthy = true;
                break;
              }
              lastErr = "unexpected health body: " + JSON.stringify(body);
            } else {
              lastErr = "health status " + res.status;
            }
          } catch (err) {
            lastErr = err;
          }
          await sleep(2000);
        }
        if (!healthy) {
          throw new Error(
            "control-plane never became healthy. last=" + String(lastErr),
          );
        }

        // Create a project -> proves Postgres + provisioning work in-compose.
        const createRes = await fetch("http://localhost:8080/v1/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-podkit-key": "podkit-dev",
          },
          body: JSON.stringify({ slug: "composedemo", owner: "ci" }),
        });
        const createBody = await createRes.json();
        expect(createBody.ok).toBe(true);
        expect(typeof createBody.data.connectionString).toBe("string");
      } catch (err) {
        bootError = err;
        // Capture diagnostics for environmental failures.
        const logs = await captureLogs();
        console.error("compose boot failed:\n" + String(err) + "\n" + logs);
      } finally {
        try {
          await compose(["down", "-v"]);
        } catch {
          // ignore teardown errors
        }
      }

      if (bootError) {
        // The artifacts (Dockerfile/compose) are the deliverable. An
        // environmental boot failure should surface but the caller decides
        // (reported as DONE_WITH_CONCERNS) — re-throw so the test record is honest.
        throw bootError instanceof Error
          ? bootError
          : new Error(String(bootError));
      }

      // Assert no leftover containers for this compose project.
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        "label=com.docker.compose.project=" + project,
        "--format",
        "{{.Names}}",
      ]);
      expect(stdout.trim()).toBe("");
    },
    600000,
  );
});
