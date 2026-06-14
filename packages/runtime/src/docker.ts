import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
