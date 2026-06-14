import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";

const execFileAsync = promisify(execFile);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Probe a single URL once. Resolves with the HTTP status code, or null if the
 * connection failed / timed out (container not yet listening). Uses a short
 * per-attempt timeout so a hung socket doesn't stall the whole poll.
 */
function probeOnce(
  host: string,
  port: number,
  path: string,
  perAttemptTimeoutMs: number,
): Promise<number | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };
    const req = httpRequest(
      { host, port, path, method: "GET", timeout: perAttemptTimeoutMs },
      (res) => {
        const code = res.statusCode ?? null;
        // Drain and discard the body so the socket can close cleanly.
        res.resume();
        done(code);
      },
    );
    req.on("error", () => done(null));
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
    req.end();
  });
}

/**
 * Bounded readiness poll for a freshly-started container. Repeatedly probes
 * `GET http://{host}:{port}/health` every 500ms until the deadline. A response
 * is considered "ready" when its status is 2xx (lenient: any success), OR when
 * /health 404s but `/` returns any non-5xx status — the fallback for apps that
 * don't expose a dedicated /health endpoint but do serve their root quickly.
 * Connection-refused / timeout attempts simply retry until the deadline.
 *
 * Returns true iff the container became ready within `timeoutMs`. The caller
 * routes traffic ONLY on true, so the gateway never sees a half-started
 * container (zero-downtime: the old container stays routed until the new one is
 * provably ready). Defaults to a 30s budget with 500ms intervals (~60 attempts).
 */
export async function waitForReadiness(
  host: string,
  port: number,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const intervalMs = 500;
  const perAttemptTimeoutMs = 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Primary: /health. A 2xx means ready.
    const healthStatus = await probeOnce(host, port, "/health", perAttemptTimeoutMs);
    if (healthStatus !== null && healthStatus >= 200 && healthStatus < 300) {
      return true;
    }
    // Fallback for apps without /health: if /health was reachable but not a
    // success (e.g. 404), probe "/" and accept any non-5xx status — most web
    // apps return 200 (or a redirect) on their root once they're listening.
    if (healthStatus !== null) {
      const rootStatus = await probeOnce(host, port, "/", perAttemptTimeoutMs);
      if (rootStatus !== null && rootStatus < 500) {
        return true;
      }
    }
    await sleep(intervalMs);
  }
  return false;
}

export interface BuildImageOptions {
  contextDir: string;
  tag: string;
}

export interface BuildImageResult {
  tag: string;
}

export interface RunContainerOptions {
  image: string;
  name: string;
  containerPort: number;
  env?: Record<string, string>;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  nofile?: number;
  // Attach the container to this Docker network. When the control-plane itself
  // runs in a container, it reaches app containers by name over a shared
  // network (the published host port is on the host's loopback, unreachable
  // from inside the control-plane container).
  network?: string;
}

export interface RunContainerResult {
  id: string;
  hostPort: number;
}

/**
 * Build a Docker image from a build context directory.
 * Runs `docker build -t <tag> <contextDir>`.
 */
export async function buildImage(opts: BuildImageOptions): Promise<BuildImageResult> {
  await execFileAsync("docker", ["build", "-t", opts.tag, opts.contextDir]);
  return { tag: opts.tag };
}

/**
 * Run a container detached and publish its port to a random host port on localhost only.
 * Runs `docker run -d --rm --label podkit.test=1 --name <name> -p 127.0.0.1:0:<containerPort>
 * --cap-drop ALL --security-opt no-new-privileges
 * --memory <memory> --cpus <cpus> --pids-limit <pidsLimit> --ulimit nofile=<nofile>:<nofile>
 * [-e K=V ...] <image>` then reads the assigned host port via `docker port <name> <containerPort>`.
 *
 * Resource limits default to memory=512m, cpus=0.5, pidsLimit=512, nofile=1024 to contain
 * fork bombs and memory exhaustion DoS from tenant containers against the host and co-tenants.
 * Hardening: ports bind to 127.0.0.1 (no external exposure), all Linux capabilities are dropped,
 * and no-new-privileges blocks setuid/setgid privilege escalation inside the container.
 */
export async function runContainer(opts: RunContainerOptions): Promise<RunContainerResult> {
  const args = [
    "run",
    "-d",
    "--rm",
    "--label",
    "podkit.test=1",
    "--name",
    opts.name,
    "-p",
    `127.0.0.1:0:${opts.containerPort}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    opts.memory ?? "512m",
    "--cpus",
    opts.cpus ?? "0.5",
    "--pids-limit",
    String(opts.pidsLimit ?? 512),
    "--ulimit",
    `nofile=${opts.nofile ?? 1024}:${opts.nofile ?? 1024}`,
  ];

  if (opts.network) {
    args.push("--network", opts.network);
  }

  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(opts.image);

  const { stdout: runStdout } = await execFileAsync("docker", args);
  const id = runStdout.trim();

  const { stdout: portStdout } = await execFileAsync("docker", [
    "port",
    opts.name,
    String(opts.containerPort),
  ]);
  const hostPort = parseHostPort(portStdout);

  return { id, hostPort };
}

/**
 * Force-remove a container by name. Ignores errors (e.g. already gone).
 * Runs `docker rm -f <name>`.
 */
export async function stopContainer(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", name]);
  } catch {
    // Ignore: container may already be stopped/removed.
  }
}

export interface ContainerLogsOptions {
  /** Limit output to the last N lines (maps to `docker logs --tail N`). */
  tail?: number;
  /**
   * Only show logs since this time. Passed straight to `docker logs --since`,
   * which accepts ISO 8601 timestamps and relative durations (e.g. "10m").
   * Letting docker do the filtering avoids brittle in-process timestamp parsing.
   */
  since?: string;
}

/**
 * Read the logs of a container by name.
 * Runs `docker logs [--tail N] [--since S] <name>`. Docker writes logs to both
 * stdout and stderr, so both streams are concatenated.
 *
 * `tail`/`since` are passed as separate execFile argv elements (never shell
 * interpolated), so untrusted values cannot inject commands.
 */
export async function containerLogs(
  name: string,
  opts?: ContainerLogsOptions,
): Promise<string> {
  const args = ["logs"];
  if (
    opts?.tail !== undefined &&
    Number.isInteger(opts.tail) &&
    opts.tail > 0
  ) {
    args.push("--tail", String(opts.tail));
  }
  if (opts?.since !== undefined && opts.since !== "") {
    args.push("--since", opts.since);
  }
  args.push(name);
  const { stdout, stderr } = await execFileAsync("docker", args);
  return stdout + stderr;
}

/**
 * Parse the output of `docker port` into a numeric host port.
 * Output looks like one or more lines of `0.0.0.0:54321` or `[::]:54321`.
 */
function parseHostPort(output: string): number {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const match = line.match(/:(\d+)$/);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    }
  }

  throw new Error(`Could not parse host port from docker port output: ${JSON.stringify(output)}`);
}
