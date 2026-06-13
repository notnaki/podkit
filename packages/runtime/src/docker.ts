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
 * Run a container detached and publish its port to a random host port.
 * Runs `docker run -d --rm --label podkit.test=1 --name <name> -p 0:<containerPort> [-e K=V ...] <image>`
 * then reads the assigned host port via `docker port <name> <containerPort>`.
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
    `0:${opts.containerPort}`,
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

/**
 * Read the logs of a container by name.
 * Runs `docker logs <name>`. Docker writes logs to both stdout and stderr,
 * so both streams are concatenated.
 */
export async function containerLogs(name: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("docker", ["logs", name]);
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
