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

// Default tag for the vendored "base" image: the full podkit monorepo with all
// @podkit/* packages + node_modules preinstalled. Standalone app builds FROM
// this so they never rebuild the framework — they only install the app's extra
// deps. Operators override via PODKIT_BASE_IMAGE (e.g. a registry-cached tag).
export const DEFAULT_BASE_IMAGE = "podkit-base:latest";

export interface GenerateStandalonePodkitDockerfileOptions {
  // Subpath, inside the uploaded context, that holds the app (app/routes, etc.).
  // For a true standalone upload the app is at the context root, so "." (the
  // default). For a monorepo-in-base layout this could point deeper, but the
  // standalone generator always copies the app into a fresh /workspace/app.
  appSubpath: string;
  port?: number;
  // Base image to build FROM. Defaults to DEFAULT_BASE_IMAGE; the control-plane
  // resolves PODKIT_BASE_IMAGE and threads it through here.
  baseImage?: string;
}

export interface BuildPodkitAppOptions {
  repoRoot: string;
  appSubpath: string;
  tag: string;
  port?: number;
  // When true (and the dir is a podkit app), build via the vendored base image
  // using generateStandalonePodkitDockerfile instead of the monorepo generator.
  // This is the Vercel-like one-click path: a standalone app (no Dockerfile, not
  // the monorepo) FROMs podkit-base and only installs its own extra deps.
  standaloneMode?: boolean;
  // Base image to use in standalone mode (defaults to DEFAULT_BASE_IMAGE).
  baseImage?: string;
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
# Production runtime config: real React prod build (no dev warnings/checks) and
# the framework's Secure-cookie defaults. (Image slimming via pnpm prune --prod
# is unsafe in this grafted pnpm workspace — it strips the @podkit/* links the
# CLI needs at runtime — so it's deferred to a framework packaging change.)
ENV NODE_ENV=production
RUN chown -R node:node /app
WORKDIR /app/${opts.appSubpath}
EXPOSE ${port}
USER node
CMD ["node","/app/packages/cli/src/bin.ts","start","--port","${port}"]
`;
}

// Path inside the base image's pnpm workspace where the uploaded standalone app
// is grafted. The base's pnpm-workspace.yaml globs `apps/*`, so placing the app
// at /app/apps/_standalone makes it a first-class workspace member: a `pnpm
// install` from the workspace root resolves its `@podkit/*` workspace:* deps
// against the already-present packages AND fetches/links its extra deps
// (react, react-dom, custom packages). This is the only reliable way to satisfy
// `workspace:*` deps — installing the app in isolation outside the workspace
// fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
const STANDALONE_APP_DIR = "/app/apps/_standalone";

/**
 * Generate a Dockerfile (as a string) for a STANDALONE podkit app, built on top
 * of the vendored "base" image (the full monorepo with all @podkit/* packages +
 * node_modules preinstalled). This is the Vercel-like one-click path: a user
 * uploads just their app (no Dockerfile, NOT the monorepo) and it builds fast
 * because the framework is already present in the base.
 *
 * Two stages, both FROM the base image:
 *   Stage 1 (builder): graft the uploaded app into the base's workspace at
 *     ${STANDALONE_APP_DIR} (covered by the workspace's `apps/*` glob), then run
 *     `pnpm install` FROM THE WORKSPACE ROOT (/app). This resolves the app's
 *     `@podkit/*` workspace:* deps against the preinstalled packages and
 *     fetches/links its extra deps. --no-frozen-lockfile lets a standalone app
 *     install even when its lockfile is absent/partial (the base's lockfile
 *     already pins the @podkit/* graph). Then run the production build.
 *   Stage 2 (runtime): FROM the base again, overlay the built workspace, drop to
 *     the unprivileged `node` user, and CMD `podkit start`.
 *
 * The base image's CLI (at /app/packages/cli/src/bin.ts) is reused for build +
 * start, so the app process runs the same Vite-free prod server as monorepo
 * deploys. Port (default 3000) is the firm podkit convention.
 */
export function generateStandalonePodkitDockerfile(
  opts: GenerateStandalonePodkitDockerfileOptions,
): string {
  const port = opts.port ?? 3000;
  const baseImage = opts.baseImage ?? DEFAULT_BASE_IMAGE;
  const appBuildDir = `${STANDALONE_APP_DIR}/.podkit/build`;
  return `# syntax: standalone podkit app on the vendored base image.
FROM ${baseImage} AS builder
RUN corepack enable
WORKDIR ${STANDALONE_APP_DIR}
COPY . .
# Install from the workspace ROOT so the grafted app's workspace:* deps resolve
# against the preinstalled @podkit/* packages and its extra deps are fetched.
RUN cd /app && pnpm install --no-frozen-lockfile
RUN node /app/packages/cli/src/bin.ts build --appRoot ${STANDALONE_APP_DIR} --outDir ${appBuildDir}

FROM ${baseImage} AS runtime
# Production runtime config: real React prod build + the framework's Secure-cookie
# defaults. (Image slimming via pnpm prune --prod is unsafe in this grafted pnpm
# workspace — it strips the @podkit/* links the CLI needs — so it's deferred.)
ENV NODE_ENV=production
COPY --from=builder /app /app
RUN chown -R node:node /app
WORKDIR ${STANDALONE_APP_DIR}
EXPOSE ${port}
USER node
CMD ["node","/app/packages/cli/src/bin.ts","start","--port","${port}"]
`;
}

/**
 * Zero-config buildpack: detect a podkit app, synthesize a Dockerfile, and build
 * a runnable image.
 *
 * Two modes:
 *   - monorepo (default): build context is the repo ROOT and the generated
 *     Dockerfile FROMs node:22, installs the whole workspace, and runs the app
 *     under appSubpath. Used for `podkit cloud deploy myapp --appSubpath=apps/x`.
 *   - standalone (`standaloneMode: true`): build context is the uploaded app
 *     ITSELF and the generated Dockerfile FROMs the vendored base image, only
 *     installing the app's extra deps. The Vercel-like one-click path.
 *
 * Runs `docker build -f <dockerfile> -t <tag> <context>` via execFile (argv
 * array, no shell).
 */
export async function buildPodkitApp(opts: BuildPodkitAppOptions): Promise<BuildPodkitAppResult> {
  const port = opts.port ?? 3000;
  const appDir = join(opts.repoRoot, opts.appSubpath);

  if (!isPodkitApp(appDir)) {
    throw new Error("not a podkit app: " + opts.appSubpath);
  }

  let dockerfile: string;
  let buildContext: string;
  if (opts.standaloneMode) {
    // Standalone: build FROM the vendored base, context = the app dir itself.
    dockerfile = generateStandalonePodkitDockerfile({
      appSubpath: ".",
      port,
      baseImage: opts.baseImage,
    });
    buildContext = appDir;
  } else {
    // Monorepo: build FROM node:22, context = the repo root.
    dockerfile = generatePodkitDockerfile({ appSubpath: opts.appSubpath, port });
    buildContext = opts.repoRoot;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "podkit-bp-"));
  const dockerfilePath = join(tmpDir, "Dockerfile");
  writeFileSync(dockerfilePath, dockerfile);

  await execFileAsync("docker", ["build", "-f", dockerfilePath, "-t", opts.tag, buildContext]);

  return { tag: opts.tag, port };
}
