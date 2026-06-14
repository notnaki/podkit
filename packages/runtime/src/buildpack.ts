import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GeneratePodkitDockerfileOptions {
  appSubpath: string;
  port?: number;
}

export interface BuildPodkitAppOptions {
  repoRoot: string;
  appSubpath: string;
  tag: string;
  port?: number;
}

export interface BuildPodkitAppResult {
  tag: string;
  port: number;
}

/**
 * Detect whether a directory is a podkit app.
 * The buildpack signature is the presence of `<appDir>/app/routes`.
 */
export function isPodkitApp(appDir: string): boolean {
  return existsSync(join(appDir, "app", "routes"));
}

/**
 * Generate a Dockerfile (as a string) for a podkit monorepo app.
 *
 * The build context is the repo ROOT (so the whole pnpm workspace is available
 * for `pnpm install`). We then `WORKDIR` into the app subpath so the podkit dev
 * server, which uses `process.cwd()` as the app root, resolves the right routes.
 *
 * Production runtime: after install, we run a production build (Vite client +
 * SSR builds, emitting hashed client assets and pre-compiled SSR route modules
 * into <app>/.podkit/build) and the container CMD runs the Vite-free `start`
 * (prod) server against that build output.
 */
export function generatePodkitDockerfile(opts: GeneratePodkitDockerfileOptions): string {
  const port = opts.port ?? 3000;
  const appBuildDir = `/app/${opts.appSubpath}/.podkit/build`;
  // Build steps run as root (corepack/pnpm need to write into the global store
  // and node_modules; the production build writes into .podkit/build). Once the
  // build completes, hand ownership of /app to the unprivileged `node` user
  // (uid 1000, present in the node:22 image) and drop privileges via USER so the
  // tenant app process never runs as root. Port ${port} is non-privileged
  // (>1024), so binding works without root.
  return `FROM node:22
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY . .
RUN pnpm install --frozen-lockfile=false
RUN node /app/packages/cli/src/bin.ts build --appRoot /app/${opts.appSubpath} --outDir ${appBuildDir}
RUN chown -R node:node /app
WORKDIR /app/${opts.appSubpath}
EXPOSE ${port}
USER node
CMD ["node","/app/packages/cli/src/bin.ts","start","--port","${port}"]
`;
}

/**
 * Zero-config buildpack: detect a podkit app, synthesize a Dockerfile, and build
 * a runnable image from the repo root context.
 *
 * Runs `docker build -f <dockerfile> -t <tag> <repoRoot>` via execFile (argv
 * array, no shell).
 */
export async function buildPodkitApp(opts: BuildPodkitAppOptions): Promise<BuildPodkitAppResult> {
  const port = opts.port ?? 3000;

  if (!isPodkitApp(join(opts.repoRoot, opts.appSubpath))) {
    throw new Error("not a podkit app: " + opts.appSubpath);
  }

  const dockerfile = generatePodkitDockerfile({ appSubpath: opts.appSubpath, port });
  const tmpDir = mkdtempSync(join(tmpdir(), "podkit-bp-"));
  const dockerfilePath = join(tmpDir, "Dockerfile");
  writeFileSync(dockerfilePath, dockerfile);

  await execFileAsync("docker", ["build", "-f", dockerfilePath, "-t", opts.tag, opts.repoRoot]);

  return { tag: opts.tag, port };
}
