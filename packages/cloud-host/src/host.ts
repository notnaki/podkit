import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  createReadStream,
  createWriteStream,
  statSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, extname, relative, isAbsolute, sep } from "node:path";
import { Client } from "pg";
import { createStore } from "@podkit/cloud-store";
import {
  buildImage,
  runContainer,
  stopContainer,
  containerLogs,
  isPodkitApp,
  buildPodkitApp,
  waitForReadiness,
  DEFAULT_BASE_IMAGE,
} from "@podkit/runtime";
import { createGateway } from "@podkit/gateway";
import { createMetricsRegistry } from "@podkit/telemetry";
import {
  listTables,
  getRows,
  insertRow,
  updateRow,
  deleteRow,
} from "./db-tables.ts";
import {
  provisionDatabase,
  dropDatabase,
  createBranchDatabase,
  dropBranchDatabase,
  sanitizeSlug,
  roleNameForDatabase,
} from "@podkit/db-provision";
import {
  requireApiKey,
  createRouter,
  sendJson,
  readJson,
  parseCorsOrigins,
  resolveCorsHeader,
} from "@podkit/cloud";
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  resolveAuthSecret,
} from "@podkit/auth";

export type CreateCloudOptions = {
  controlPlaneConnectionString: string;
  adminConnectionString: string;
  apiKey?: string;
  consoleDir?: string;
  corsOrigins?: string;
  // Vendored base image standalone app builds build FROM. Defaults to
  // PODKIT_BASE_IMAGE env, then the runtime's DEFAULT_BASE_IMAGE.
  baseImage?: string;
  // Abuse caps (default from env, else permissive). maxProjectsPerAccount 0 =
  // unlimited; rateLimitPerMin <=0 disables API rate limiting.
  maxProjectsPerAccount?: number;
  rateLimitPerMin?: number;
};

export type Cloud = {
  listen: (opts: {
    apiPort: number;
    gatewayPort: number;
  }) => Promise<{ apiUrl: string; gatewayUrl: string }>;
  close: () => Promise<void>;
};

// Token TTL constants (seconds).
const ACCOUNT_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days (web account/session tokens)
const CLI_TOKEN_TTL = 90 * 24 * 60 * 60; // 90 days (CLI/automation tokens)

function ok(data: unknown) {
  return { ok: true, data };
}

function fail(code: string, message: string, hint?: string) {
  return { ok: false, error: { code, message, hint } };
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function mimeForExt(ext: string): string {
  return MIME[ext] ?? "application/octet-stream";
}

// Parse the project slug out of a public gateway path like `/_p/<slug>/...`.
function slugFromPath(path: string): string | null {
  const match = /^\/_p\/([^/?#]+)/.exec(path);
  return match ? match[1]! : null;
}

// The "active" production deployment is the most recent deploy/rollback — NOT
// simply the last row of listDeployments. listDeployments returns oldest-first
// and mixes kinds: preview (kind="preview") and teardown (kind="stopped",
// containerId="") rows are appended to the same per-project history but never
// own the production route. So scan newest -> oldest and stop at the first
// deploy/rollback. Shared by GET /deployments, DELETE /projects/:slug, and
// GET /logs so they all agree on which deployment is serving traffic.
function findActiveDeployment<T extends { kind: string }>(
  deployments: ReadonlyArray<T>,
): T | undefined {
  for (let i = deployments.length - 1; i >= 0; i--) {
    const d = deployments[i]!;
    if (d.kind === "deploy" || d.kind === "rollback") {
      return d;
    }
  }
  return undefined;
}

// Reject any SQL that is not a single, read-only SELECT. This is a deliberately
// conservative allow/deny gate layered *in front of* the per-project scoped role
// (which is the real isolation boundary — see provisionDatabase): even a parser
// bypass here cannot reach another tenant's database. We:
//   - require the statement to start with SELECT (allowlist),
//   - reject any DML/DDL/admin verb or dangerous builtin (denylist),
//   - reject multi-statement input (a ';' anywhere but an optional trailing one),
// so DML, DDL, COPY, stored-proc calls, pg_sleep / pg_read_file / pg_ls_dir, and
// stacked statements are all turned away before a connection is opened.
function isSelectOnly(sql: string): boolean {
  const trimmed = sql.trim();
  if (!/^SELECT\b/i.test(trimmed)) return false;
  if (
    /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|pg_sleep|pg_read_file|pg_ls_dir)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }
  // Single statement only: a ';' is allowed solely as an optional trailing char.
  const withoutTrailing = trimmed.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) return false;
  return true;
}

// A branch name is a short lowercase identifier ([a-z0-9_], starting with an
// alphanumeric) that becomes part of a Postgres database + role name. We validate
// (never sanitize) so two distinct requests can't collide on the same DB.
function isValidBranchName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9][a-z0-9_]{0,49}$/.test(name);
}

// Broad classes of system / shared directories a build context must never point
// at. Pointing a build at any of these would (at best) fail at build time and
// (at worst) leak host source or secrets into an image, so reject them up front.
const SYSTEM_PATHS = [
  "/etc",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/sys",
  "/proc",
  "/dev",
  "/root",
  "/home",
  "/tmp",
];

// True when `target` is equal to, or nested inside, `base` (both absolute,
// real, normalized). Uses path.relative so it is robust against ".." and
// trailing-separator differences and works cross-platform.
function isWithin(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

type ContextDirResult =
  | { path: string }
  | { error: { code: string; message: string; hint: string } };

// Validate and resolve a caller-supplied build-context directory. Resolving to
// the real path (realpathSync) collapses symlinks and ".." so the checks below
// see the true on-disk location an attacker cannot disguise.
function validateContextDir(
  input: string,
  controlPlaneRoot: string,
  buildsRoot: string | null,
): ContextDirResult {
  if (typeof input !== "string" || input.length === 0) {
    return {
      error: {
        code: "E_BAD_ARGS",
        message: "contextDir is required",
        hint: "pass an absolute path to the build context directory",
      },
    };
  }
  let real: string;
  try {
    real = realpathSync(resolve(input));
  } catch {
    return {
      error: {
        code: "E_BAD_ARGS",
        message: "contextDir does not exist or cannot be read",
        hint: "pass a path to an existing directory you control",
      },
    };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(real);
  } catch {
    return {
      error: {
        code: "E_BAD_ARGS",
        message: "contextDir does not exist or cannot be read",
        hint: "pass a path to an existing directory you control",
      },
    };
  }
  if (!stat.isDirectory()) {
    return {
      error: {
        code: "E_BAD_ARGS",
        message: "contextDir is not a directory",
        hint: "pass a path to a directory, not a file",
      },
    };
  }
  // Always reject overlap with the control-plane source root, even inside an
  // explicit builds sandbox: the control plane's own source is never a tenant
  // build context.
  if (isWithin(controlPlaneRoot, real)) {
    return {
      error: {
        code: "E_BAD_ARGS",
        message: "contextDir overlaps with the control-plane source root",
        hint: "build from your application directory, not the podkit control plane",
      },
    };
  }
  if (buildsRoot !== null) {
    // An explicit sandbox is the authoritative allowlist: the operator has
    // opted into this location, so confinement to it replaces the broad
    // system-path denylist (which is the default-on guardrail otherwise).
    if (!isWithin(buildsRoot, real)) {
      return {
        error: {
          code: "E_BAD_ARGS",
          message:
            "contextDir is outside the allowed builds root (set via PODKIT_BUILDS_ROOT)",
          hint: "place the build context under " + buildsRoot,
        },
      };
    }
    return { path: real };
  }
  if (real === sep) {
    return {
      error: {
        code: "E_BAD_ARGS",
        message: "contextDir points to a system directory (rejected for security)",
        hint: "build from an application source directory, not the filesystem root",
      },
    };
  }
  for (const sysPath of SYSTEM_PATHS) {
    if (isWithin(sysPath, real)) {
      return {
        error: {
          code: "E_BAD_ARGS",
          message:
            "contextDir points to a system directory (rejected for security)",
          hint: "build from an application source directory, not " + sysPath,
        },
      };
    }
  }
  return { path: real };
}

const execFileAsync = promisify(execFile);

// Hard ceiling on an uploaded tarball, enforced while streaming to disk so a
// malicious/oversized upload is rejected (413) without ever buffering the whole
// body in memory. 500 MiB is generous for source + a small lockfile/asset set
// but far below anything that should reach a single-host control plane.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MiB

// Stream a request body to `destPath` with a bounded size guard. Resolves once
// the body is fully written; rejects with code "E_PAYLOAD_TOO_LARGE" the instant
// the cumulative byte count exceeds maxBytes (the stream is destroyed and the
// partial file removed). Backpressure is preserved by piping into the file
// write stream, so a fast client cannot blow up control-plane memory: Node only
// buffers up to the write stream's highWaterMark before pausing the socket.
function streamUploadToFile(
  req: IncomingMessage,
  destPath: string,
  maxBytes: number,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const out = createWriteStream(destPath);
    let total = 0;
    let settled = false;

    const cleanupAndReject = (err: Error) => {
      if (settled) return;
      settled = true;
      // Stop writing; best-effort remove the partial file. We deliberately do
      // NOT destroy the request socket here — the caller drains it and sends a
      // proper status response (e.g. 413). Destroying mid-upload would reset the
      // connection and the client would see a socket error instead of our JSON.
      req.unpipe(out);
      out.destroy();
      try {
        rmSync(destPath, { force: true });
      } catch {
        // best-effort
      }
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanupAndReject(
          Object.assign(new Error("payload too large"), {
            code: "E_PAYLOAD_TOO_LARGE",
          }),
        );
      }
    });
    req.on("error", (err) => cleanupAndReject(err as Error));
    out.on("error", (err) => cleanupAndReject(err as Error));
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });

    req.pipe(out);
  });
}

// Recursively audit every extracted entry and reject if any of them escapes
// `extractDir`. realpathSync collapses symlinks and ".." to the true on-disk
// location, so a crafted symlink or "../.." entry cannot disguise itself: we
// resolve each entry and confirm it is still within extractDir. Symlinks are
// detected via lstat (which does NOT follow the link) and their resolved target
// is validated explicitly. Returns true when the tree is safe.
function validateExtractedPaths(extractDir: string): boolean {
  const realRoot = realpathSync(extractDir);

  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(full);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) {
        // Resolve the link target's real path; reject if it escapes the root.
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          // A symlink whose target cannot be resolved (dangling or outside the
          // dir) is rejected — we never follow an unverifiable link.
          return false;
        }
        if (!isWithin(realRoot, target) && target !== realRoot) {
          return false;
        }
        // Do not descend through symlinks (target already validated as inside).
        continue;
      }
      // For real files/dirs, resolve and confirm containment.
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        return false;
      }
      if (!isWithin(realRoot, real) && real !== realRoot) {
        return false;
      }
      if (stat.isDirectory()) {
        if (!walk(full)) return false;
      }
    }
    return true;
  };

  return walk(realRoot);
}

// Synchronously extract a gzipped tarball into a FRESH directory with strict
// path-traversal protection, then return the extracted dir on success. The
// caller owns cleanup of `extractDir` (we do NOT rm it here on success so the
// build can read from it); on ANY failure we clean it up before rejecting so no
// partial/malicious state leaks. Defense is layered: a pre-flight `tar -tzf`
// listing audit (reject absolute / ".." entries), portable extraction (plain
// `tar -xzf -C`, no -P, so tar strips leading "/" and refuses ".."), and a
// post-extract realpath/symlink audit (validateExtractedPaths).
async function extractTarGz(
  tarPath: string,
  extractDir: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    // Pre-flight audit of the archive listing: reject absolute paths and any
    // ".." segment BEFORE writing a single file to disk. `tar -tzf` lists
    // entries without extracting.
    try {
      const { stdout } = await execFileAsync("tar", ["-tzf", tarPath]);
      const entries = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const e of entries) {
        if (e.startsWith("/")) {
          return {
            ok: false,
            code: "E_BAD_ARGS",
            message: "tarball contains an absolute path entry",
          };
        }
        if (e.split("/").some((seg) => seg === "..")) {
          return {
            ok: false,
            code: "E_BAD_ARGS",
            message: "tarball contains a parent-directory (..) entry",
          };
        }
      }
    } catch {
      return {
        ok: false,
        code: "E_BAD_ARGS",
        message: "tarball is corrupted or not a valid gzip archive",
      };
    }

    // Extract with portable, safe flags (works on both GNU and BSD/macOS tar).
    // We deliberately OMIT -P / --absolute-names so tar strips any leading "/"
    // and refuses ".." entries by default (BSD tar errors on "..", GNU tar
    // strips the path) — combined with the pre-flight listing audit above and
    // the post-extract realpath audit below, this is layered defense. -C
    // confines all output to the fresh extraction dir.
    try {
      await execFileAsync("tar", ["-xzf", tarPath, "-C", extractDir]);
    } catch {
      return {
        ok: false,
        code: "E_BAD_ARGS",
        message: "tarball could not be extracted",
      };
    }

    // Post-extract audit: realpath every entry and reject escaping symlinks or
    // any path that resolves outside the extract dir.
    if (!validateExtractedPaths(extractDir)) {
      return {
        ok: false,
        code: "E_BAD_ARGS",
        message: "tarball contains an entry that escapes the extraction directory",
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      code: "E_BAD_ARGS",
      message: "tarball could not be processed",
    };
  }
}

export function createCloud(opts: CreateCloudOptions): Cloud {
  const store = createStore({
    connectionString: opts.controlPlaneConnectionString,
  });
  const apiKey = opts.apiKey;
  const consoleDir = opts.consoleDir ? resolve(opts.consoleDir) : undefined;
  // Optional CORS allowlist. Unset (null) preserves the permissive "*" default
  // so local dev and the Vite proxy keep working; when set, only listed Origins
  // are reflected back (with Vary: Origin so caches stay correct).
  const allowedOrigins = parseCorsOrigins(
    opts.corsOrigins ?? process.env.PODKIT_CORS_ORIGINS ?? undefined,
  );
  // Secret used to sign/verify account (and CLI) bearer tokens.
  const authSecret = resolveAuthSecret();

  // Build-context sandboxing. The control-plane source root is never a valid
  // build context; default it to the resolved cwd at startup (overridable for
  // deployments where the control plane runs from a different directory).
  // PODKIT_BUILDS_ROOT, when set, confines all build contexts under one
  // operator-chosen directory (an explicit opt-in sandbox).
  const controlPlaneRoot = (() => {
    const raw = process.env.PODKIT_CONTROL_PLANE_ROOT ?? process.cwd();
    try {
      return realpathSync(resolve(raw));
    } catch {
      return resolve(raw);
    }
  })();
  const buildsRoot = (() => {
    const raw = process.env.PODKIT_BUILDS_ROOT;
    if (!raw) return null;
    try {
      return realpathSync(resolve(raw));
    } catch {
      return resolve(raw);
    }
  })();

  // Root under which uploaded tarballs are streamed and extracted. Prefers an
  // operator-set PODKIT_BUILDS_ROOT (so uploads land on the same dedicated,
  // quota-enforced volume as local-path builds), then PODKIT_CONTROL_PLANE_ROOT
  // /builds, then the OS temp dir as a last resort. Per-project subdirs are
  // created on demand. We resolve (not realpath) so a not-yet-existing dir is
  // still usable; we mkdir -p it before first use.
  const uploadsRoot = (() => {
    const raw =
      process.env.PODKIT_BUILDS_ROOT ??
      (process.env.PODKIT_CONTROL_PLANE_ROOT
        ? join(process.env.PODKIT_CONTROL_PLANE_ROOT, "builds")
        : join(tmpdir(), "podkit-builds"));
    return resolve(raw);
  })();

  // Resolve an authenticated account from an Authorization: Bearer <token>
  // header. Returns null when the header is missing/malformed or the token is
  // invalid or lacks a string accountId claim.
  async function accountFromAuth(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ accountId: string } | null> {
    const raw = headers["authorization"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (!match) return null;
    const token = match[1]!;
    const payload = verifyToken(token, authSecret);
    if (!payload) return null;
    // Revocation check (after signature/expiry so we don't query the DB for
    // invalid tokens). Backward-compatible: tokens minted before this feature
    // have no jti, so the check is skipped and they keep working.
    const jti = payload["jti"];
    if (typeof jti === "string" && (await store.isTokenRevoked(jti))) {
      return null;
    }
    const accountId = payload["accountId"];
    if (typeof accountId !== "string") return null;
    return { accountId };
  }

  // A mutation is authorized when EITHER the machine API key matches OR a valid
  // user/CLI bearer token is present.
  async function guardMutation(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (requireApiKey(headers, apiKey)) return true;
    return (await accountFromAuth(headers)) !== null;
  }

  // Authorize access to a specific project. The machine API key grants full
  // access; otherwise a valid bearer token is required AND the account must own
  // the project. Returns a discriminant the caller maps to a 401/403 response.
  async function authorizeProject(
    headers: Record<string, string | string[] | undefined>,
    project: { owner: string },
  ): Promise<"ok" | "unauth" | "forbidden"> {
    if (requireApiKey(headers, apiKey)) return "ok";
    const auth = await accountFromAuth(headers);
    if (!auth) return "unauth";
    if (project.owner !== auth.accountId) return "forbidden";
    return "ok";
  }

  // When set, app containers join this Docker network and the gateway reaches
  // them by container name (required when the control-plane itself runs in a
  // container — the published host port lives on the host's loopback, which is
  // unreachable from inside the control-plane container). Unset (host-mode:
  // tests / local dev) => reach the app via the published port on localhost.
  const appNetwork = process.env.PODKIT_APP_NETWORK || undefined;

  // Vendored base image for standalone app builds. Resolution order:
  // explicit option -> PODKIT_BASE_IMAGE env -> runtime default
  // (podkit-base:latest). ensureBaseImage() (called from listen()) builds it
  // from infra/Dockerfile.base if it isn't already present locally.
  const baseImage =
    opts.baseImage || process.env.PODKIT_BASE_IMAGE || DEFAULT_BASE_IMAGE;

  // Build the vendored base image (the full monorepo with @podkit/* + node_modules
  // preinstalled) once, if it isn't already present locally. Idempotent: a
  // `docker image inspect` hit short-circuits, so repeated control-plane restarts
  // reuse the cached image. When the operator points PODKIT_BASE_IMAGE at a
  // pre-built/registry tag and it already exists, this is a no-op. We log but do
  // NOT throw on a build failure — standalone deploys will fail fast later with a
  // clear "base image not found" error from docker build, while Dockerfile/monorepo
  // deploys (which don't need the base) keep working.
  async function ensureBaseImage(): Promise<void> {
    try {
      await execFileAsync("docker", ["image", "inspect", baseImage]);
      return; // already present
    } catch {
      // Not present locally; fall through to build it.
    }
    const dockerfilePath = join(controlPlaneRoot, "infra", "Dockerfile.base");
    if (!existsSync(dockerfilePath)) {
      console.error(
        "podkit-base image is missing and infra/Dockerfile.base was not found at " +
          dockerfilePath +
          " — standalone app deploys will fail until the base image (" +
          baseImage +
          ") is available. Set PODKIT_BASE_IMAGE to a pre-built tag.",
      );
      return;
    }
    try {
      console.error(
        "building vendored base image " +
          baseImage +
          " (one-time) from " +
          dockerfilePath +
          " ...",
      );
      await execFileAsync(
        "docker",
        ["build", "-f", dockerfilePath, "-t", baseImage, controlPlaneRoot],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      console.error("vendored base image " + baseImage + " is ready");
    } catch (err) {
      console.error(
        "failed to build vendored base image " +
          baseImage +
          ": " +
          (err instanceof Error ? err.message : String(err)) +
          " — standalone app deploys will fail until it is built; Dockerfile/monorepo deploys are unaffected.",
      );
    }
  }

  // route key -> the address the gateway dials for the live container.
  const routeMap = new Map<string, { host: string; port: number }>();

  // Build the gateway target for a freshly-started container: in network mode
  // dial the container by name on its container port; otherwise the published
  // host port on localhost.
  const routeTarget = (
    containerName: string,
    containerPort: number,
    hostPort: number,
  ): { host: string; port: number } =>
    appNetwork
      ? { host: containerName, port: containerPort }
      : { host: "localhost", port: hostPort };
  // custom domain (hostname, no port) -> project slug.
  const domainMap = new Map<string, string>();
  // names of app containers we started, so close() can tear them down.
  const runningContainers: string[] = [];
  // slug -> name of the container currently serving it, so a new deploy/rollback
  // can reap the one it superseded (otherwise dead containers leak until close).
  const activeContainer = new Map<string, string>();
  // Preview lifecycle is tracked separately from production: slug -> branchName
  // -> name of the container currently serving that preview. A preview redeploy
  // reaps only its own prior preview container, never the production one (and
  // vice versa), so a project's prod + N branch previews coexist independently.
  const activePreview = new Map<string, Map<string, string>>();

  // Stop a container by name and forget it (best-effort, idempotent).
  async function stopAndForget(name: string): Promise<void> {
    const idx = runningContainers.indexOf(name);
    if (idx !== -1) runningContainers.splice(idx, 1);
    try {
      await stopContainer(name);
    } catch {
      // Best-effort: the container may already be gone.
    }
  }

  // Make `name` the live container for `slug` and stop the one it replaced.
  // Called AFTER routeMap is switched, so the old container is already off the
  // routing path — reaping it only reclaims resources, never drops traffic.
  async function reapSuperseded(slug: string, name: string): Promise<void> {
    const prev = activeContainer.get(slug);
    activeContainer.set(slug, name);
    if (prev && prev !== name) {
      await stopAndForget(prev);
    }
  }

  // Preview analogue of reapSuperseded, scoped to (slug, branchName). Stops the
  // previous preview container for that exact branch only; production and other
  // branches are untouched. Single-threaded (Node event loop), so the nested
  // Map mutation is race-free across concurrent preview redeploys.
  async function reapSupersededPreview(
    slug: string,
    branchName: string,
    name: string,
  ): Promise<void> {
    let byBranch = activePreview.get(slug);
    if (!byBranch) {
      byBranch = new Map<string, string>();
      activePreview.set(slug, byBranch);
    }
    const prev = byBranch.get(branchName);
    byBranch.set(branchName, name);
    if (prev && prev !== name) {
      await stopAndForget(prev);
    }
  }

  // In-memory fixed-window rate limiter for CLI approval, keyed by accountId.
  // A secondary defense against userCode brute-forcing: even with high entropy,
  // we cap how fast an authenticated account can grind approval attempts.
  const approveAttempts = new Map<
    string,
    { count: number; windowStart: number }
  >();
  const APPROVE_RATE_LIMIT = 10; // max attempts per window
  const APPROVE_WINDOW_MS = 60000; // 60-second fixed window

  function checkApproveRateLimit(accountId: string): boolean {
    const now = Date.now();
    const record = approveAttempts.get(accountId);
    if (!record || now - record.windowStart >= APPROVE_WINDOW_MS) {
      // No record, or the window has expired: start a fresh window.
      approveAttempts.set(accountId, { count: 1, windowStart: now });
      return true;
    }
    if (record.count >= APPROVE_RATE_LIMIT) {
      return false; // rate limited
    }
    record.count++;
    return true;
  }

  // General API rate limiter (fixed window, per credential or IP). A baseline
  // abuse defense for a public control-plane. PODKIT_RATE_LIMIT_PER_MIN<=0
  // disables it; the default is generous so normal CLI/console use is unaffected.
  const RATE_LIMIT_PER_MIN =
    opts.rateLimitPerMin ?? Number(process.env.PODKIT_RATE_LIMIT_PER_MIN ?? "600");
  const apiRate = new Map<string, { count: number; windowStart: number }>();
  function checkApiRateLimit(key: string): boolean {
    if (!Number.isFinite(RATE_LIMIT_PER_MIN) || RATE_LIMIT_PER_MIN <= 0) {
      return true;
    }
    const now = Date.now();
    const rec = apiRate.get(key);
    if (!rec || now - rec.windowStart >= 60000) {
      apiRate.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (rec.count >= RATE_LIMIT_PER_MIN) return false;
    rec.count++;
    return true;
  }

  // Max projects an account may own (0 = unlimited). Caps resource abuse when
  // the control-plane is exposed publicly. The machine API key is exempt.
  const MAX_PROJECTS_PER_ACCOUNT =
    opts.maxProjectsPerAccount ??
    Number(process.env.PODKIT_MAX_PROJECTS_PER_ACCOUNT ?? "0");

  // Shared build+run+record+route pipeline for both production deploys and
  // branch previews. The caller is responsible for credential/ownership checks
  // and for validating/resolving contextDir BEFORE calling this. Production uses
  // kind="deploy"/"rollback" + branchId=null + routeMap key <slug>; a preview
  // uses kind="preview" + a branchId + routeMap key <slug>--<branchName>, so a
  // preview never clobbers the production route (distinct key, port, container).
  type DeployResult =
    | { version: string; hostPort: number; containerName: string }
    | { error: { status: number; code: string; message: string; hint?: string } };

  async function buildAndDeploy(input: {
    slug: string;
    projectId: string;
    contextDir: string;
    appSubpath?: string;
    containerPort: number;
    kind: string;
    branchId: string | null;
    branchName?: string;
    // When true, a podkit app (no Dockerfile) builds via the vendored base image
    // (standalone, Vercel-like): the build context is the app itself and only its
    // extra deps are installed. When false/undefined, a podkit app under
    // appSubpath builds via the monorepo generator (the original path). Ignored
    // when an explicit Dockerfile is present (the user opt-out always wins).
    standalone?: boolean;
    // Extra env merged on top of the project's env vars (e.g. the branch's
    // scoped DATABASE_URL for a preview). These take precedence so a preview's
    // DB conn string overrides any project-level DATABASE_URL.
    extraEnv?: Record<string, string>;
  }): Promise<DeployResult> {
    const { slug, contextDir } = input;
    const version = "v" + randomBytes(4).toString("hex");
    const tag = "podkit-" + slug + ":" + version;
    // Preview containers get a name that encodes the branch so they're easy to
    // spot; production keeps the historical podkit-app-<slug>-<rand> shape.
    const name =
      input.kind === "preview" && input.branchName
        ? "podkit-preview-" +
          slug +
          "-" +
          input.branchName +
          "-" +
          randomBytes(3).toString("hex")
        : "podkit-app-" + slug + "-" + randomBytes(3).toString("hex");

    // Build the image: an explicit Dockerfile wins; otherwise, if it's a podkit
    // app (has app/routes), the buildpack generates one — zero-config.
    const appDir = input.appSubpath
      ? join(contextDir, input.appSubpath)
      : contextDir;
    if (existsSync(join(appDir, "Dockerfile"))) {
      // (1) Explicit Dockerfile wins — user opt-out of the buildpack entirely.
      await buildImage({ contextDir: appDir, tag });
    } else if (isPodkitApp(appDir)) {
      // (2) Standalone one-click: build FROM the vendored base image, context =
      //     the uploaded app itself. (3) Otherwise monorepo: build FROM node:22
      //     with the whole workspace and the app under appSubpath.
      await buildPodkitApp({
        repoRoot: contextDir,
        appSubpath: input.appSubpath ?? ".",
        tag,
        port: input.containerPort,
        standaloneMode: input.standalone === true,
        baseImage,
      });
    } else {
      return {
        error: {
          status: 400,
          code: "E_BAD_ARGS",
          message: "no Dockerfile and not a podkit app",
          hint: "add a Dockerfile, or deploy a podkit app (with app/routes)",
        },
      };
    }

    // Build the container env. Precedence (lowest → highest):
    //   1. the project's managed-Postgres connection string as DATABASE_URL, so
    //      a production deploy talks to its provisioned database by default
    //      (previews override this below with their branch-scoped URL);
    //   2. the project's user-set environment variables (env set);
    //   3. extraEnv (e.g. a preview's branch-scoped DATABASE_URL).
    const env: Record<string, string> = {};
    const projectDbUrl = await store.getProjectDbUrl(input.projectId);
    if (projectDbUrl) {
      env.DATABASE_URL = projectDbUrl;
    }
    const envRows = await store.listEnv(input.projectId);
    for (const row of envRows) {
      env[row.key] = row.value;
    }
    if (input.extraEnv) {
      for (const [k, v] of Object.entries(input.extraEnv)) {
        env[k] = v;
      }
    }

    const { id, hostPort } = await runContainer({
      image: tag,
      name,
      containerPort: input.containerPort,
      env,
      network: appNetwork,
    });
    runningContainers.push(name);

    // The container is live but not yet routed or persisted. If the deployment
    // row insert fails, stop+forget the orphaned container before rethrowing so
    // the deploy stays atomic — no leaked container, no in-memory dangling name.
    // Node is single-threaded with no await between push and recordDeployment,
    // so this cleanup is race-free.
    try {
      await store.recordDeployment({
        projectId: input.projectId,
        version,
        containerId: id,
        hostPort,
        status: "running",
        containerPort: input.containerPort,
        kind: input.kind,
        branchId: input.branchId,
      });
    } catch (err) {
      await stopAndForget(name);
      throw err;
    }

    const target = routeTarget(name, input.containerPort, hostPort);

    // Bounded readiness poll BEFORE routing any traffic: probe the new container
    // until it answers (2xx on /health, or any non-5xx on / as a fallback) or a
    // 30s budget elapses. We poll the SAME address the gateway will dial (network
    // mode => container-name:containerPort; host mode => localhost:hostPort) so a
    // pass guarantees the gateway can reach it. If it never becomes ready, we do
    // NOT set the route (the old container stays serving = zero-downtime); we
    // stop+forget the dead container and the deployment row stays as a failed
    // historical record. This is the gateway-never-sees-a-half-broken-route
    // guarantee from the one-click design.
    const ready = await waitForReadiness(target.host, target.port, 30000);
    if (!ready) {
      await stopAndForget(name);
      return {
        error: {
          status: 503,
          code: "E_CONTAINER_FAILED",
          message: "container did not become ready within 30s",
          hint: "ensure the app listens on port " +
            input.containerPort +
            " and returns 2xx on /health (or / quickly)",
        },
      };
    }

    if (input.kind === "preview" && input.branchName) {
      const routeKey = slug + "--" + input.branchName;
      routeMap.set(routeKey, target);
      await reapSupersededPreview(slug, input.branchName, name);
    } else {
      routeMap.set(slug, target);
      await reapSuperseded(slug, name);
    }

    return { version, hostPort, containerName: name };
  }

  // Orchestrate the upload-based deploy: extract the uploaded tarball into a
  // FRESH temp subdir, audit every entry for path traversal / escaping symlinks,
  // then build+run from the extracted dir via buildAndDeploy. The extracted dir
  // and the uploaded tarball are ALWAYS removed in the finally block — on
  // success, failure, or thrown error — so no tenant source or partial state
  // ever leaks on disk. `extractParent` is the per-upload directory that holds
  // both the tarball and the extraction subdir; we rm -rf the whole thing.
  async function extractAndBuild(input: {
    tarPath: string;
    extractParent: string;
    slug: string;
    projectId: string;
    containerPort: number;
    appSubpath?: string;
    extraEnv?: Record<string, string>;
    kind?: string;
    branchId?: string | null;
    branchName?: string;
  }): Promise<DeployResult> {
    const extractDir = join(input.extractParent, "extracted");
    try {
      mkdirSync(extractDir, { recursive: true });
      const extracted = await extractTarGz(input.tarPath, extractDir);
      if (!extracted.ok) {
        return {
          error: {
            status: 400,
            code: extracted.code,
            message: extracted.message,
          },
        };
      }
      // The extracted dir is a fresh, audited, control-plane-owned path, so it
      // is a valid build context by construction; pass it straight through.
      //
      // Standalone detection: an upload with NO appSubpath is a true standalone
      // app (the app is at the tarball root) -> build via the vendored base image
      // (one-click). An upload WITH appSubpath is a monorepo tarball -> the
      // original monorepo generator (standalone=false) preserves backward compat.
      // buildAndDeploy only consults `standalone` for podkit apps without a
      // Dockerfile; a Dockerfile upload ignores it entirely.
      const standalone = !input.appSubpath;
      return await buildAndDeploy({
        slug: input.slug,
        projectId: input.projectId,
        contextDir: extractDir,
        appSubpath: input.appSubpath,
        containerPort: input.containerPort,
        kind: input.kind ?? "deploy",
        branchId: input.branchId ?? null,
        branchName: input.branchName,
        standalone,
        extraEnv: input.extraEnv,
      });
    } finally {
      // Guaranteed cleanup: rm -rf the entire per-upload dir (tarball + extracted
      // tree). Node's single-threaded event loop runs this finally before the
      // next request is handled. Best-effort: a failed rm only leaks disk, which
      // the operator monitors on the dedicated builds volume.
      try {
        rmSync(input.extractParent, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  // Resolved once listen() binds the gateway, used to build public URLs.
  let gatewayUrl = "";

  // Sealed in-process registry of per-project request metrics (counts, status
  // classes, latency only). Never persisted; resets on restart.
  const metrics = createMetricsRegistry();

  const gateway = createGateway({
    resolve: ({ host, path }) => {
      // Path-based routing (/_p/<slug>) wins; otherwise fall back to the
      // Host header for custom-domain routing.
      let slug = slugFromPath(path);
      if (!slug) {
        // Strip any :port from the Host header before lookup.
        const hostname = host.replace(/:\d+$/, "");
        slug = domainMap.get(hostname) ?? null;
      }
      if (!slug) return null;
      const target = routeMap.get(slug);
      // Thread the resolved slug out so onRequest can attribute the request.
      return target ? { host: target.host, hostPort: target.port, slug } : null;
    },
    onRequest: (m) => {
      // Only record for requests that resolved to a known project slug.
      if (m.slug) metrics.record({ slug: m.slug, statusCode: m.statusCode, latencyMs: m.latencyMs });
    },
  });

  const router = createRouter();

  const unauthorized = (): { status: number; body: unknown } => ({
    status: 401,
    body: fail(
      "E_UNAUTHORIZED",
      "missing or invalid credentials",
      "send x-podkit-key or Authorization: Bearer <token>",
    ),
  });

  const forbidden = (): { status: number; body: unknown } => ({
    status: 403,
    body: fail("E_FORBIDDEN", "not project owner"),
  });

  router.register("GET", "/v1/health", () => ({
    status: 200,
    body: ok({ status: "ok" }),
  }));

  router.register("GET", "/v1/projects", async ({ headers }) => {
    // Enrich each project with its latest deployment + routed URL so the
    // console can render Vercel-style cards (domain + status) without N fetches.
    // The machine key sees everything; a user only sees projects they own.
    const all = await store.listProjects();
    let projects = all;
    if (!requireApiKey(headers, apiKey)) {
      const auth = await accountFromAuth(headers);
      if (!auth) return unauthorized();
      projects = all.filter((p) => p.owner === auth.accountId);
    }
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const deps = await store.listDeployments(p.id);
        const latest = deps[deps.length - 1] ?? null;
        return {
          ...p,
          version: latest ? latest.version : null,
          status: latest ? latest.status : null,
          lastDeployedAt: latest ? (latest.createdAt ?? null) : null,
          url: latest ? gatewayUrl + "/_p/" + p.slug + "/" : null,
        };
      }),
    );
    return { status: 200, body: ok({ projects: enriched }) };
  });

  router.register("POST", "/v1/projects", async ({ headers, body }) => {
    if (!(await guardMutation(headers))) return unauthorized();
    const b = (body ?? {}) as { slug?: string; owner?: string };
    if (!b.slug || typeof b.slug !== "string") {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "slug required", "POST /v1/projects {slug}"),
      };
    }
    // Ownership is bound to the creating account so the per-project authz checks
    // work for real bearer clients (the CLI/console don't know their accountId).
    // The machine API key has no account, so it may assign an owner explicitly.
    const creator = await accountFromAuth(headers);
    const owner = creator ? creator.accountId : b.owner ?? "";
    // Per-account project quota (machine API key is exempt). 0 = unlimited.
    if (creator && MAX_PROJECTS_PER_ACCOUNT > 0) {
      const all = await store.listProjects();
      const mine = all.filter((p) => p.owner === creator.accountId).length;
      if (mine >= MAX_PROJECTS_PER_ACCOUNT) {
        return {
          status: 403,
          body: fail(
            "E_QUOTA",
            "project limit reached (" + MAX_PROJECTS_PER_ACCOUNT + ")",
            "delete an unused project, or ask the operator to raise the limit",
          ),
        };
      }
    }
    const project = await store.createProject({
      slug: b.slug,
      owner,
    });
    const db = await provisionDatabase({
      adminConnectionString: opts.adminConnectionString,
      slug: b.slug,
    });
    // Persist the scoped connection string (encrypted at rest) so the SQL runner
    // can reuse it without re-provisioning (which would rotate the password).
    await store.setProjectDbUrl(project.id, db.connectionString);
    return {
      status: 200,
      body: ok({
        project,
        database: db.database,
        connectionString: db.connectionString,
      }),
    };
  });

  router.register(
    "POST",
    "/v1/projects/:slug/deploy",
    async ({ headers, params, body }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const b = (body ?? {}) as {
        contextDir?: string;
        containerPort?: number;
        appSubpath?: string;
      };
      if (!b.contextDir || typeof b.containerPort !== "number") {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "contextDir and containerPort required",
            "POST /v1/projects/:slug/deploy {contextDir, containerPort}",
          ),
        };
      }
      if (b.appSubpath !== undefined) {
        const subpath = b.appSubpath;
        const safe =
          typeof subpath === "string" &&
          subpath.length > 0 &&
          !subpath.startsWith("/") &&
          /^[A-Za-z0-9._/-]+$/.test(subpath) &&
          !subpath.split("/").some((seg) => seg === "..");
        if (!safe) {
          return {
            status: 400,
            body: fail(
              "E_BAD_ARGS",
              "invalid appSubpath",
              "appSubpath must be a safe relative path with no .. segments",
            ),
          };
        }
      }
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();

      // Validate + resolve the build context to a real on-disk path, rejecting
      // system directories, the control-plane source, and (when configured)
      // anything outside the builds sandbox. Defense-in-depth alongside the
      // appSubpath whitelist above and Docker's own filesystem isolation.
      // Runs AFTER the ownership check so its distinct filesystem-probing error
      // messages can't leak host state to authenticated non-owner callers.
      const ctx = validateContextDir(b.contextDir, controlPlaneRoot, buildsRoot);
      if ("error" in ctx) {
        return {
          status: 400,
          body: fail(ctx.error.code, ctx.error.message, ctx.error.hint),
        };
      }
      const contextDir = ctx.path;

      const result = await buildAndDeploy({
        slug,
        projectId: project.id,
        contextDir,
        appSubpath: b.appSubpath,
        containerPort: b.containerPort,
        kind: "deploy",
        branchId: null,
      });
      if ("error" in result) {
        return {
          status: result.error.status,
          body: fail(
            result.error.code,
            result.error.message,
            result.error.hint,
          ),
        };
      }
      return {
        status: 200,
        body: ok({
          version: result.version,
          hostPort: result.hostPort,
          url: gatewayUrl + "/_p/" + slug + "/",
        }),
      };
    },
  );

  // Deploy a branch as an isolated preview. Secure-by-default ladder: guard
  // credentials, resolve the project (404), enforce ownership (401/403), then
  // validate the branch exists FOR THIS PROJECT and inject the branch's SCOPED
  // (non-admin) connection string as DATABASE_URL. The preview routes under
  // <slug>--<branchName> so it never clobbers production.
  router.register(
    "POST",
    "/v1/projects/:slug/deploy-branch",
    async ({ headers, params, body }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const b = (body ?? {}) as {
        branchName?: unknown;
        contextDir?: string;
        containerPort?: number;
        appSubpath?: string;
      };
      // Reject branch names with "--" (or any invalid char): the route key joins
      // slug + "--" + branchName, so a "--" in the branch name could collide.
      if (!isValidBranchName(b.branchName)) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid branch name",
            "branchName must match ^[a-z0-9][a-z0-9_]{0,49}$ (no '--')",
          ),
        };
      }
      const branchName = b.branchName;
      if (!b.contextDir || typeof b.containerPort !== "number") {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "contextDir and containerPort required",
            "POST /v1/projects/:slug/deploy-branch {branchName, contextDir, containerPort}",
          ),
        };
      }
      if (b.appSubpath !== undefined) {
        const subpath = b.appSubpath;
        const safe =
          typeof subpath === "string" &&
          subpath.length > 0 &&
          !subpath.startsWith("/") &&
          /^[A-Za-z0-9._/-]+$/.test(subpath) &&
          !subpath.split("/").some((seg) => seg === "..");
        if (!safe) {
          return {
            status: 400,
            body: fail(
              "E_BAD_ARGS",
              "invalid appSubpath",
              "appSubpath must be a safe relative path with no .. segments",
            ),
          };
        }
      }
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();

      // Validate the build context AFTER the ownership check so its distinct
      // filesystem-probing error messages can't leak host state to
      // authenticated non-owner callers.
      const ctx = validateContextDir(b.contextDir, controlPlaneRoot, buildsRoot);
      if ("error" in ctx) {
        return {
          status: 400,
          body: fail(ctx.error.code, ctx.error.message, ctx.error.hint),
        };
      }
      const contextDir = ctx.path;

      // The branch must already exist for THIS project (scoped to projectId by
      // the store query), so a caller can't preview-deploy against another
      // tenant's branch or a non-existent one.
      const branch = await store.getBranchByName(project.id, branchName);
      if (!branch) {
        return {
          status: 404,
          body: fail(
            "E_NOT_FOUND",
            "unknown branch: " + branchName,
            "create it first: podkit cloud branches create " + slug + " " + branchName,
          ),
        };
      }
      // Retrieve the decrypted SCOPED branch connection string (never admin).
      const branchConn = await store.getBranchConnectionString(branch.id);
      if (!branchConn) {
        return {
          status: 400,
          body: fail(
            "E_BRANCH_FAILED",
            "branch has no stored connection string",
            "re-create the branch",
          ),
        };
      }

      const result = await buildAndDeploy({
        slug,
        projectId: project.id,
        contextDir,
        appSubpath: b.appSubpath,
        containerPort: b.containerPort,
        kind: "preview",
        branchId: branch.id,
        branchName,
        // Inject the branch's scoped DB conn string as DATABASE_URL; this layers
        // on top of the project's env vars and overrides any project DATABASE_URL.
        extraEnv: { DATABASE_URL: branchConn },
      });
      if ("error" in result) {
        return {
          status: result.error.status,
          body: fail(
            result.error.code,
            result.error.message,
            result.error.hint,
          ),
        };
      }
      const routeKey = slug + "--" + branchName;
      return {
        status: 200,
        body: ok({
          version: result.version,
          hostPort: result.hostPort,
          branchName,
          url: gatewayUrl + "/_p/" + routeKey + "/",
        }),
      };
    },
  );

  // Tear down an active branch preview: stop its container, clear the preview
  // route, and append a kind="stopped" deployment marker. Idempotent — a missing
  // route/container is a no-op, so a partially-failed prior teardown is safe to
  // retry. Secure-by-default: guard -> 404 -> ownership.
  router.register(
    "DELETE",
    "/v1/projects/:slug/preview/:branchName",
    async ({ headers, params }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const branchName = params.branchName!;
      if (!isValidBranchName(branchName)) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid branch name",
            "branchName must match ^[a-z0-9][a-z0-9_]{0,49}$",
          ),
        };
      }
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();

      const branch = await store.getBranchByName(project.id, branchName);
      // Stop the live preview container for this branch (tracked in-memory).
      const byBranch = activePreview.get(slug);
      const containerName = byBranch?.get(branchName);
      if (containerName) {
        await stopAndForget(containerName);
        byBranch!.delete(branchName);
        // Drop the slug's inner Map once its last preview is gone, so empty
        // Maps don't accumulate (one per distinct slug) for the process lifetime.
        if (byBranch!.size === 0) activePreview.delete(slug);
      }
      // Clear the preview route (no-op if absent).
      routeMap.delete(slug + "--" + branchName);

      // Record a teardown marker so deployment history reflects the stop.
      const preview = (await store.listDeployments(project.id))
        .filter((d) => d.kind === "preview" && branch && d.branchId === branch.id)
        .pop();
      if (preview) {
        await store.recordDeployment({
          projectId: project.id,
          version: preview.version,
          containerId: "",
          hostPort: 0,
          status: "stopped",
          containerPort: preview.containerPort,
          kind: "stopped",
          branchId: branch ? branch.id : null,
        });
      }

      return { status: 200, body: ok({ stopped: branchName }) };
    },
  );

  router.register("POST", "/v1/auth/signup", async ({ body }) => {
    const b = (body ?? {}) as { email?: string; password?: string };
    if (!b.email || typeof b.email !== "string") {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "email required", "POST {email, password}"),
      };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(b.email)) {
      return {
        status: 400,
        body: fail(
          "E_BAD_ARGS",
          "invalid email format",
          "POST {email, password}",
        ),
      };
    }
    if (!b.password || typeof b.password !== "string") {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "password required", "POST {email, password}"),
      };
    }
    if (b.password.length < 8) {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "password must be at least 8 characters"),
      };
    }
    const passwordHash = hashPassword(b.password);
    let account: { id: string; email: string };
    try {
      account = await store.createAccount({ email: b.email, passwordHash });
    } catch {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "email already registered"),
      };
    }
    const token = signToken(
      { accountId: account.id, email: account.email, jti: randomUUID() },
      authSecret,
      ACCOUNT_TOKEN_TTL,
    );
    return {
      status: 200,
      body: ok({ token, account: { id: account.id, email: account.email } }),
    };
  });

  router.register("POST", "/v1/auth/login", async ({ body }) => {
    const b = (body ?? {}) as { email?: string; password?: string };
    if (!b.email || typeof b.email !== "string" || !b.password) {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "email and password required"),
      };
    }
    const account = await store.getAccountByEmail(b.email);
    if (!account || !verifyPassword(b.password, account.passwordHash)) {
      return {
        status: 401,
        body: fail("E_UNAUTHORIZED", "invalid credentials"),
      };
    }
    const token = signToken(
      { accountId: account.id, email: account.email, jti: randomUUID() },
      authSecret,
      ACCOUNT_TOKEN_TTL,
    );
    return {
      status: 200,
      body: ok({ token, account: { id: account.id, email: account.email } }),
    };
  });

  router.register("GET", "/v1/auth/me", async ({ headers }) => {
    const auth = await accountFromAuth(headers);
    if (!auth) return unauthorized();
    const account = await store.getAccountById(auth.accountId);
    if (!account) return unauthorized();
    return { status: 200, body: ok({ account }) };
  });

  router.register("POST", "/v1/auth/logout", async ({ headers }) => {
    // Logout requires a currently-valid bearer token; we then revoke it by jti.
    const auth = await accountFromAuth(headers);
    if (!auth) return unauthorized();
    const raw = headers["authorization"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") return unauthorized();
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    if (!match) return unauthorized();
    const payload = verifyToken(match[1]!, authSecret);
    if (!payload) return unauthorized();
    const jti = payload["jti"];
    const exp = payload["exp"];
    // Old tokens (no jti) cannot be revoked; report a graceful no-op so clients
    // don't treat logout as an error.
    if (typeof jti !== "string") {
      return {
        status: 200,
        body: ok({ revoked: false, message: "token has no jti, cannot revoke" }),
      };
    }
    if (typeof exp !== "number") {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "token has no exp claim"),
      };
    }
    // Store the revocation with the token's own expiry so the row is self-GC'able.
    await store.revokeToken(jti, new Date(exp * 1000));
    return { status: 200, body: ok({ revoked: true }) };
  });

  router.register("POST", "/v1/auth/cli/start", async () => {
    // Public: the device code itself is the secret used to poll for the token.
    const deviceCode = randomBytes(24).toString("hex");
    const userCode = randomBytes(16).toString("hex");
    await store.createCliSession({ deviceCode, userCode });
    const consoleUrl =
      process.env.PODKIT_CONSOLE_URL ?? "http://localhost:5190";
    // No pre-filled code in the URL — the user types it in the console.
    // This defeats one-click phishing links.
    return {
      status: 200,
      body: ok({
        deviceCode,
        userCode,
        verifyUrl: consoleUrl + "/#/cli",
        pollInterval: 1000,
      }),
    };
  });

  router.register("POST", "/v1/auth/cli/poll", async ({ body }) => {
    const b = (body ?? {}) as { deviceCode?: string };
    if (!b.deviceCode || typeof b.deviceCode !== "string") {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "deviceCode required"),
      };
    }
    const session = await store.getCliSessionByDeviceCode(b.deviceCode);
    if (!session) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown device code"),
      };
    }
    if (session.expired && session.status !== "approved") {
      return { status: 200, body: ok({ status: "expired" }) };
    }
    if (session.status !== "approved") {
      return { status: 200, body: ok({ status: session.status }) };
    }
    return {
      status: 200,
      body: ok({ status: "approved", token: session.token }),
    };
  });

  router.register("POST", "/v1/auth/cli/approve", async ({ headers, body }) => {
    const auth = await accountFromAuth(headers);
    if (!auth) return unauthorized();
    // Secondary brute-force defense: cap approval attempts per account.
    if (!checkApproveRateLimit(auth.accountId)) {
      return {
        status: 429,
        body: fail("E_RATE_LIMITED", "too many approval attempts, try again later"),
      };
    }
    const b = (body ?? {}) as { userCode?: string };
    if (!b.userCode || typeof b.userCode !== "string") {
      return {
        status: 400,
        body: fail("E_BAD_ARGS", "userCode required"),
      };
    }
    const token = signToken(
      { accountId: auth.accountId, cli: true, jti: randomUUID() },
      authSecret,
      CLI_TOKEN_TTL,
    );
    const approved = await store.approveCliSession({
      userCode: b.userCode,
      accountId: auth.accountId,
      token,
    });
    if (!approved) {
      return {
        status: 400,
        body: fail(
          "E_BAD_ARGS",
          "code is invalid, expired, or already used",
          "start a new login",
        ),
      };
    }
    return { status: 200, body: ok({ approved: true }) };
  });

  router.register("GET", "/v1/projects/:slug", async ({ headers, params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
    const access = await authorizeProject(headers, project);
    if (access === "unauth") return unauthorized();
    if (access === "forbidden") return forbidden();
    const deployments = await store.listDeployments(project.id);
    const latest =
      deployments.length > 0 ? deployments[deployments.length - 1]! : null;
    return {
      status: 200,
      body: ok({
        project,
        latest,
        url: latest ? gatewayUrl + "/_p/" + slug + "/" : null,
      }),
    };
  });

  router.register(
    "DELETE",
    "/v1/projects/:slug",
    async ({ headers, params }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();

      // Stop the active production container if any — the most recent
      // deploy/rollback (findActiveDeployment), not blindly the last row.
      // Best effort: a pruned/already-stopped container must not block teardown.
      const deployments = await store.listDeployments(project.id);
      const active = findActiveDeployment(deployments);
      if (active && active.containerId) {
        try {
          await stopContainer(active.containerId);
        } catch {
          // Ignore: container may already be gone.
        }
      }

      // Drop the project's database + role. Best effort so a missing/already
      // dropped database does not leave the control-plane row orphaned.
      const database = sanitizeSlug(slug);
      try {
        await dropDatabase({
          adminConnectionString: opts.adminConnectionString,
          database,
          role: roleNameForDatabase(database),
        });
      } catch {
        // Ignore: database may have never been provisioned or already dropped.
      }

      // Drop every branch's Postgres DB + scoped role. Branches are separately
      // provisioned databases that exist independently of any preview deploy, so
      // they must be enumerated explicitly here or they leak after the project's
      // control-plane rows are removed. listBranches omits the role, but it
      // follows the documented `<database>_app` convention via
      // roleNameForDatabase. Best-effort + idempotent (DROP ... IF EXISTS).
      for (const branch of await store.listBranches(project.id)) {
        try {
          await dropBranchDatabase({
            adminConnectionString: opts.adminConnectionString,
            database: branch.database,
            role: roleNameForDatabase(branch.database),
          });
        } catch {
          // Ignore: a branch DB may never have been created or already dropped.
        }
      }

      // Stop any live branch-preview containers and drop their routes.
      const previews = activePreview.get(slug);
      if (previews) {
        for (const [branchName, containerName] of previews) {
          await stopAndForget(containerName);
          routeMap.delete(slug + "--" + branchName);
        }
        activePreview.delete(slug);
      }

      // Drop in-memory routing state for this project.
      routeMap.delete(slug);
      activeContainer.delete(slug);
      for (const { domain } of await store.listDomains(project.id)) {
        domainMap.delete(domain);
      }

      await store.deleteProject(project.id);

      return { status: 200, body: ok({ deleted: slug }) };
    },
  );

  router.register(
    "GET",
    "/v1/projects/:slug/deployments",
    async ({ headers, params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
    const access = await authorizeProject(headers, project);
    if (access === "unauth") return unauthorized();
    if (access === "forbidden") return forbidden();
    // store returns oldest-first. "Active" is the production deployment serving
    // the project, i.e. the most recent deploy/rollback — NOT simply the last
    // row: preview (kind="preview") and teardown (kind="stopped") rows are
    // appended to the same history but never own the production route, so they
    // must not steal the "Current" badge.
    const deployments = await store.listDeployments(project.id);
    const activeId = findActiveDeployment(deployments)?.id ?? null;
    // Present newest-first and flag which one is currently serving traffic.
    const items = deployments
      .slice()
      .reverse()
      .map((d) => ({
        id: d.id,
        version: d.version,
        status: d.status,
        kind: d.kind,
        // branchId is present only for preview deployments; omitted (null) for
        // production deploy/rollback rows.
        branchId: d.branchId,
        createdAt: d.createdAt,
        active: d.id === activeId,
      }));
    return { status: 200, body: ok({ deployments: items }) };
  },
  );

  router.register(
    "GET",
    "/v1/projects/:slug/logs",
    async ({ headers, params, query }) => {
    // Runtime logs can contain secrets (injected env, tokens), so this endpoint
    // requires credentials AND project ownership. The presence check runs first
    // so unauthenticated callers can't probe project existence via 404s.
    if (!(await guardMutation(headers))) return unauthorized();
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
    const access = await authorizeProject(headers, project);
    if (access === "unauth") return unauthorized();
    if (access === "forbidden") return forbidden();
    // Optional ?limit caps the number of returned log lines (bounds response
    // size/memory). Must be an integer in 1..10000.
    let tail: number | undefined;
    const limitParam = query.get("limit");
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (
        !Number.isInteger(n) ||
        n < 1 ||
        n > 10000 ||
        !/^\d+$/.test(limitParam)
      ) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "limit must be an integer between 1 and 10000",
            "?limit=100",
          ),
        };
      }
      tail = n;
    }
    // Optional ?since filters by time. Must be a parseable date; the original
    // string is forwarded to `docker logs --since` (ISO 8601 or relative).
    let since: string | undefined;
    const sinceParam = query.get("since");
    if (sinceParam !== null) {
      if (sinceParam === "" || Number.isNaN(new Date(sinceParam).getTime())) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "since must be a valid date",
            "?since=2026-06-14T00:00:00Z",
          ),
        };
      }
      since = sinceParam;
    }
    // Logs for a specific deployment (?deploymentId=...) or, by default, the
    // active one (the most recent deployment for this project).
    const wanted = query.get("deploymentId");
    let target: { id: string; version: string; containerId: string } | null =
      null;
    if (wanted) {
      const d = await store.getDeploymentById(wanted);
      if (d && d.projectId === project.id) {
        target = { id: d.id, version: d.version, containerId: d.containerId };
      }
    } else {
      // Default to the active production deployment — the most recent
      // deploy/rollback, not simply the last row (a kind="stopped" preview
      // teardown with containerId="" can be the last row even while production
      // is still running, which would wrongly return empty logs).
      const deployments = await store.listDeployments(project.id);
      const active = findActiveDeployment(deployments);
      if (active) {
        target = {
          id: active.id,
          version: active.version,
          containerId: active.containerId,
        };
      }
    }
    if (!target) {
      return {
        status: 200,
        body: ok({ deploymentId: null, version: null, logs: "" }),
      };
    }
    // The container is addressed by its id; docker logs accepts id or name.
    // A pruned/stopped container yields an error we surface as empty logs.
    let logs = "";
    if (target.containerId) {
      try {
        logs = await containerLogs(target.containerId, { tail, since });
      } catch {
        logs = "";
      }
    }
    return {
      status: 200,
      body: ok({
        deploymentId: target.id,
        version: target.version,
        logs,
      }),
    };
  });

  router.register(
    "GET",
    "/v1/projects/:slug/metrics",
    async ({ headers, params }) => {
      // Metrics are project-scoped operational data, so this endpoint requires
      // credentials AND project ownership. The presence check runs first so
      // unauthenticated callers can't probe project existence via 404s. Only
      // counts, status classes, and latency are returned — never bodies,
      // headers, env, paths, or other secrets.
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const snapshot = metrics.snapshot(slug) ?? {
        requests: 0,
        status2xx: 0,
        status3xx: 0,
        status4xx: 0,
        status5xx: 0,
        avgLatencyMs: 0,
        lastSeen: 0,
      };
      return { status: 200, body: ok(snapshot) };
    },
  );

  router.register(
    "POST",
    "/v1/projects/:slug/rollback",
    async ({ headers, params, body }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const b = (body ?? {}) as { deploymentId?: string };
      if (!b.deploymentId || typeof b.deploymentId !== "string") {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "deploymentId required",
            "POST /v1/projects/:slug/rollback {deploymentId}",
          ),
        };
      }
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const target = await store.getDeploymentById(b.deploymentId);
      if (!target || target.projectId !== project.id) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown deployment for this project"),
        };
      }
      if (!target.containerPort) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "deployment predates rollback support (no container port recorded)",
            "redeploy this project, then rollbacks will be available",
          ),
        };
      }

      // Re-run the immutable, version-tagged image for the target deployment.
      // Images are tagged podkit-<slug>:<version> at build time and persist, so
      // rolling back means starting a fresh container from that same image.
      const tag = "podkit-" + slug + ":" + target.version;
      const name = "podkit-app-" + slug + "-" + randomBytes(3).toString("hex");
      const envRows = await store.listEnv(project.id);
      const env: Record<string, string> = {};
      for (const row of envRows) {
        env[row.key] = row.value;
      }

      let started: { id: string; hostPort: number };
      try {
        started = await runContainer({
          image: tag,
          name,
          containerPort: target.containerPort,
          env,
          network: appNetwork,
        });
      } catch {
        return {
          status: 500,
          body: fail(
            "E_DEPLOY_FAILED",
            "could not start the image for that deployment",
            "the image for version " + target.version + " may have been pruned",
          ),
        };
      }
      runningContainers.push(name);

      // A rollback is recorded as a new deployment (append-only history) that
      // re-uses the target's version; being newest, it becomes the active one.
      // If the row insert fails, stop+forget the orphaned container before
      // rethrowing so the rollback stays atomic (mirrors buildAndDeploy).
      try {
        await store.recordDeployment({
          projectId: project.id,
          version: target.version,
          containerId: started.id,
          hostPort: started.hostPort,
          status: "running",
          containerPort: target.containerPort,
          kind: "rollback",
        });
      } catch (err) {
        await stopAndForget(name);
        throw err;
      }

      // Same zero-downtime guarantee as a fresh deploy: poll the rolled-back
      // container until it is provably serving before routing to it. If it never
      // becomes ready, leave the current route untouched and stop+forget the dead
      // container so the rollback fails fast without dropping live traffic.
      const rollbackTarget = routeTarget(
        name,
        target.containerPort,
        started.hostPort,
      );
      const ready = await waitForReadiness(
        rollbackTarget.host,
        rollbackTarget.port,
        30000,
      );
      if (!ready) {
        await stopAndForget(name);
        return {
          status: 503,
          body: fail(
            "E_CONTAINER_FAILED",
            "rolled-back container did not become ready within 30s",
            "the image for version " + target.version + " may be unhealthy",
          ),
        };
      }

      routeMap.set(slug, rollbackTarget);
      await reapSuperseded(slug, name);

      return {
        status: 200,
        body: ok({
          version: target.version,
          hostPort: started.hostPort,
          url: gatewayUrl + "/_p/" + slug + "/",
          rolledBackTo: b.deploymentId,
        }),
      };
    },
  );

  router.register(
    "POST",
    "/v1/projects/:slug/env",
    async ({ headers, params, body }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const b = (body ?? {}) as {
        key?: string;
        value?: string;
        sensitive?: boolean;
      };
      if (
        typeof b.key !== "string" ||
        b.key.length === 0 ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.key)
      ) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid env key",
            "key must match ^[A-Za-z_][A-Za-z0-9_]*$",
          ),
        };
      }
      await store.setEnv({
        projectId: project.id,
        key: b.key,
        value: typeof b.value === "string" ? b.value : "",
        sensitive: b.sensitive === true,
      });
      return { status: 200, body: ok({ key: b.key }) };
    },
  );

  router.register("GET", "/v1/projects/:slug/env", async ({ headers, params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
    const access = await authorizeProject(headers, project);
    if (access === "unauth") return unauthorized();
    if (access === "forbidden") return forbidden();
    const items = await store.listEnv(project.id);
    return {
      status: 200,
      body: ok({
        env: items.map((item) => ({
          key: item.key,
          sensitive: item.sensitive,
          value: item.sensitive ? null : item.value,
        })),
      }),
    };
  });

  router.register(
    "DELETE",
    "/v1/projects/:slug/env/:key",
    async ({ headers, params }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const key = params.key!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      await store.deleteEnv({ projectId: project.id, key });
      return { status: 200, body: ok({ deleted: key }) };
    },
  );

  router.register(
    "POST",
    "/v1/projects/:slug/db/query",
    async ({ headers, params, body, query }) => {
      // Read-only SQL runner. Same guard ladder as the logs/env handlers: the
      // mutation guard runs first so unauthenticated callers can't probe project
      // existence via 404s, then ownership is enforced. The query itself runs as
      // the per-project (or per-branch) SCOPED non-superuser role (never
      // adminConnectionString), so even a parser bypass cannot reach another
      // tenant's database.
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();

      // Optional ?branchName=<name> targets a branch's isolated DB. When set, we
      // use the branch's SCOPED conn string (not the project's, never admin), so
      // the query is confined to that branch's database.
      const branchNameParam = query.get("branchName");
      if (branchNameParam !== null && !isValidBranchName(branchNameParam)) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid branch name",
            "branchName must match ^[a-z0-9][a-z0-9_]{0,49}$",
          ),
        };
      }

      const b = (body ?? {}) as { sql?: unknown; params?: unknown };
      if (typeof b.sql !== "string" || b.sql.trim().length === 0) {
        return {
          status: 400,
          body: fail(
            "E_INVALID_QUERY",
            "sql is required",
            "POST {sql, params?} — a single read-only SELECT statement",
          ),
        };
      }
      if (!isSelectOnly(b.sql)) {
        return {
          status: 400,
          body: fail(
            "E_INVALID_QUERY",
            "only a single read-only SELECT statement is allowed",
            "no DML/DDL/COPY/CALL, no stacked statements",
          ),
        };
      }
      // Caller values flow ONLY through pg $1..$N parameter slots (never string
      // interpolation), so they can't alter the statement. Validate the shape.
      let values: (string | number)[] = [];
      if (b.params !== undefined) {
        if (
          !Array.isArray(b.params) ||
          !b.params.every(
            (p) => typeof p === "string" || typeof p === "number",
          )
        ) {
          return {
            status: 400,
            body: fail(
              "E_INVALID_QUERY",
              "params must be an array of strings/numbers",
              'POST {sql, params: ["a", 1]}',
            ),
          };
        }
        values = b.params as (string | number)[];
      }
      // Cap result memory by appending a LIMIT when the caller didn't supply one.
      const sql = b.sql.trim().replace(/;\s*$/, "");
      const capped = /\bLIMIT\b/i.test(sql) ? sql : sql + " LIMIT 1000";

      // Connect as the project's SCOPED non-superuser role (<db>_app) — never
      // the admin/superuser creds — so the query is confined to this one
      // tenant's database (PUBLIC CONNECT is revoked on every other DB). The
      // scoped connection string is stored (encrypted) at create time; we reuse
      // it so we don't re-provision/rotate the password on every query. Projects
      // created before this was added have no stored URL — provision once and
      // persist it (a one-time rotation), then reuse thereafter.
      let scopedConnectionString: string | null;
      try {
        if (branchNameParam !== null) {
          // Branch-targeted query: resolve the branch (scoped to this project),
          // then use its decrypted scoped conn string. Never falls back to the
          // project/admin DB, so isolation is preserved.
          const branch = await store.getBranchByName(project.id, branchNameParam);
          if (!branch) {
            return {
              status: 404,
              body: fail("E_NOT_FOUND", "unknown branch: " + branchNameParam),
            };
          }
          scopedConnectionString = await store.getBranchConnectionString(
            branch.id,
          );
        } else {
          scopedConnectionString = await store.getProjectDbUrl(project.id);
          if (!scopedConnectionString) {
            const provisioned = await provisionDatabase({
              adminConnectionString: opts.adminConnectionString,
              slug,
            });
            scopedConnectionString = provisioned.connectionString;
            await store.setProjectDbUrl(project.id, scopedConnectionString);
          }
        }
      } catch {
        return {
          status: 400,
          body: fail("E_QUERY_FAILED", "could not run the query"),
        };
      }

      if (!scopedConnectionString) {
        return {
          status: 400,
          body: fail("E_QUERY_FAILED", "could not run the query"),
        };
      }
      const db = new Client({ connectionString: scopedConnectionString });
      try {
        await db.connect();
        // Bound runaway queries; constant, not interpolated user input.
        await db.query("SET statement_timeout = 5000");
        const result = await db.query(capped, values);
        return {
          status: 200,
          body: ok({ rows: result.rows, rowCount: result.rowCount }),
        };
      } catch {
        // Generic message only — never leak driver internals/SQLSTATE/stack.
        return {
          status: 400,
          body: fail("E_QUERY_FAILED", "could not run the query"),
        };
      } finally {
        try {
          await db.end();
        } catch {
          // Ignore: connection may have failed to open.
        }
      }
    },
  );

  // ---------------- Table editor: browse + CRUD over the scoped DB ----------------
  //
  // Backs the console's data editor. Every endpoint runs the same guard ladder as
  // db/query (guardMutation -> 404 -> ownership) and connects as the project's
  // SCOPED non-superuser role (or a branch's), never admin — so it can only ever
  // touch this one tenant's database. Identifier safety lives in db-tables.ts.

  type LoadedProject = NonNullable<Awaited<ReturnType<typeof store.getProjectBySlug>>>;

  async function guardProject(
    headers: Record<string, string | string[] | undefined>,
    slug: string,
  ): Promise<{ project: LoadedProject } | { resp: { status: number; body: unknown } }> {
    if (!(await guardMutation(headers))) return { resp: unauthorized() };
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return { resp: { status: 404, body: fail("E_NOT_FOUND", "unknown project: " + slug) } };
    }
    const access = await authorizeProject(headers, project);
    if (access === "unauth") return { resp: unauthorized() };
    if (access === "forbidden") return { resp: forbidden() };
    return { project };
  }

  function branchParam(
    query: URLSearchParams,
  ): { branchName: string | null } | { resp: { status: number; body: unknown } } {
    const b = query.get("branchName");
    if (b !== null && !isValidBranchName(b)) {
      return {
        resp: {
          status: 400,
          body: fail("E_BAD_ARGS", "invalid branch name", "branchName must match ^[a-z0-9][a-z0-9_]{0,49}$"),
        },
      };
    }
    return { branchName: b };
  }

  // Resolve the SCOPED conn string for a project or one of its branches (never admin).
  async function resolveScopedConn(
    project: LoadedProject,
    branchName: string | null,
  ): Promise<{ conn: string } | { resp: { status: number; body: unknown } }> {
    try {
      if (branchName !== null) {
        const branch = await store.getBranchByName(project.id, branchName);
        if (!branch) {
          return { resp: { status: 404, body: fail("E_NOT_FOUND", "unknown branch: " + branchName) } };
        }
        const conn = await store.getBranchConnectionString(branch.id);
        if (!conn) {
          return { resp: { status: 400, body: fail("E_QUERY_FAILED", "could not resolve the branch database") } };
        }
        return { conn };
      }
      let conn = await store.getProjectDbUrl(project.id);
      if (!conn) {
        const provisioned = await provisionDatabase({
          adminConnectionString: opts.adminConnectionString,
          slug: project.slug,
        });
        conn = provisioned.connectionString;
        await store.setProjectDbUrl(project.id, conn);
      }
      return { conn };
    } catch {
      return { resp: { status: 400, body: fail("E_QUERY_FAILED", "could not resolve the database") } };
    }
  }

  // Connect as the scoped role, bound the statement timeout, run fn, always close.
  // db-tables throws Errors with safe, owner-facing messages (unknown table/column,
  // or a constraint violation on the owner's OWN database); surface them so the
  // editor is usable — this is the project owner acting on their own data.
  async function withScopedClient(
    project: LoadedProject,
    branchName: string | null,
    fn: (client: Client) => Promise<unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const resolved = await resolveScopedConn(project, branchName);
    if ("resp" in resolved) return resolved.resp;
    const client = new Client({ connectionString: resolved.conn });
    try {
      await client.connect();
      await client.query("SET statement_timeout = 5000");
      const data = await fn(client);
      return { status: 200, body: ok(data) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "operation failed";
      return { status: 400, body: fail("E_DB_ERROR", message.slice(0, 300)) };
    } finally {
      try {
        await client.end();
      } catch {
        // connection may have failed to open
      }
    }
  }

  router.register("GET", "/v1/projects/:slug/db/tables", async ({ headers, params, query }) => {
    const guard = await guardProject(headers, params.slug!);
    if ("resp" in guard) return guard.resp;
    const bp = branchParam(query);
    if ("resp" in bp) return bp.resp;
    return withScopedClient(guard.project, bp.branchName, async (c) => ({ tables: await listTables(c) }));
  });

  router.register("GET", "/v1/projects/:slug/db/tables/:table", async ({ headers, params, query }) => {
    const guard = await guardProject(headers, params.slug!);
    if ("resp" in guard) return guard.resp;
    const bp = branchParam(query);
    if ("resp" in bp) return bp.resp;
    const limit = Number(query.get("limit") ?? "50");
    const offset = Number(query.get("offset") ?? "0");
    return withScopedClient(guard.project, bp.branchName, (c) =>
      getRows(c, params.table!, {
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    );
  });

  router.register("POST", "/v1/projects/:slug/db/tables/:table", async ({ headers, params, query, body }) => {
    const guard = await guardProject(headers, params.slug!);
    if ("resp" in guard) return guard.resp;
    const bp = branchParam(query);
    if ("resp" in bp) return bp.resp;
    const values = ((body ?? {}) as { values?: Record<string, unknown> }).values ?? {};
    return withScopedClient(guard.project, bp.branchName, async (c) => ({ row: await insertRow(c, params.table!, values) }));
  });

  router.register("PATCH", "/v1/projects/:slug/db/tables/:table", async ({ headers, params, query, body }) => {
    const guard = await guardProject(headers, params.slug!);
    if ("resp" in guard) return guard.resp;
    const bp = branchParam(query);
    if ("resp" in bp) return bp.resp;
    const b = (body ?? {}) as { pk?: Record<string, unknown>; values?: Record<string, unknown> };
    return withScopedClient(guard.project, bp.branchName, async (c) => ({
      row: await updateRow(c, params.table!, b.pk ?? {}, b.values ?? {}),
    }));
  });

  router.register("DELETE", "/v1/projects/:slug/db/tables/:table", async ({ headers, params, query, body }) => {
    const guard = await guardProject(headers, params.slug!);
    if ("resp" in guard) return guard.resp;
    const bp = branchParam(query);
    if ("resp" in bp) return bp.resp;
    const b = (body ?? {}) as { pk?: Record<string, unknown> };
    return withScopedClient(guard.project, bp.branchName, async (c) => {
      await deleteRow(c, params.table!, b.pk ?? {});
      return { deleted: true };
    });
  });

  router.register(
    "POST",
    "/v1/projects/:slug/domains",
    async ({ headers, params, body }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const b = (body ?? {}) as { domain?: string };
      const domain = b.domain;
      if (
        typeof domain !== "string" ||
        !/^[a-z0-9.-]+$/.test(domain) ||
        !domain.includes(".")
      ) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid domain",
            "domain must match ^[a-z0-9.-]+$ and contain a dot",
          ),
        };
      }
      await store.addDomain({ projectId: project.id, domain });
      domainMap.set(domain, slug);
      return { status: 200, body: ok({ domain }) };
    },
  );

  router.register(
    "GET",
    "/v1/projects/:slug/domains",
    async ({ headers, params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
    const access = await authorizeProject(headers, project);
    if (access === "unauth") return unauthorized();
    if (access === "forbidden") return forbidden();
    return {
      status: 200,
      body: ok({ domains: await store.listDomains(project.id) }),
    };
  },
  );

  router.register(
    "DELETE",
    "/v1/projects/:slug/domains/:domain",
    async ({ headers, params }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const domain = params.domain!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      await store.deleteDomain({ projectId: project.id, domain });
      domainMap.delete(domain);
      return { status: 200, body: ok({ deleted: domain }) };
    },
  );

  router.register(
    "POST",
    "/v1/projects/:slug/branches",
    async ({ headers, params, body }) => {
      // Creating a branch provisions a real (scoped-role) clone DB, so it is a
      // mutation: guard credentials, resolve the project, then enforce ownership.
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const b = (body ?? {}) as { name?: unknown };
      if (!isValidBranchName(b.name)) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid branch name",
            "name must match ^[a-z0-9][a-z0-9_]{0,49}$ (lowercase, 1-50 chars)",
          ),
        };
      }
      const name = b.name;

      // Clone the base project DB into an isolated branch DB with its own scoped
      // non-superuser role. Never hand out the admin connection string.
      let branchDb: { database: string; role: string; connectionString: string };
      try {
        branchDb = await createBranchDatabase({
          adminConnectionString: opts.adminConnectionString,
          baseSlug: slug,
          branchName: name,
        });
      } catch {
        // Generic message — never leak driver internals / SQLSTATE.
        return {
          status: 400,
          body: fail(
            "E_BRANCH_FAILED",
            "could not create the branch database",
            "ensure the project has a base database (it is created with the project)",
          ),
        };
      }

      // Persist the branch (encrypted scoped URL). UNIQUE(project_id, name)
      // makes concurrent creates of the same name race-safe: the loser gets a
      // 400. On store failure, best-effort drop the just-created DB so we don't
      // orphan a database with no control-plane row.
      let stored: { id: string };
      try {
        stored = await store.addBranch({
          projectId: project.id,
          name,
          database: branchDb.database,
          role: branchDb.role,
          connectionString: branchDb.connectionString,
        });
      } catch {
        try {
          await dropBranchDatabase({
            adminConnectionString: opts.adminConnectionString,
            database: branchDb.database,
            role: branchDb.role,
          });
        } catch {
          // Best-effort: a GC sweep can reclaim a stale branch DB later.
        }
        return {
          status: 400,
          body: fail(
            "E_BRANCH_EXISTS",
            "a branch with that name already exists",
            "pick a different branch name",
          ),
        };
      }

      // The scoped connection string is returned exactly once, at create time
      // (same pattern as project create), so the caller can put it in .env.
      return {
        status: 200,
        body: ok({
          branch: {
            id: stored.id,
            name,
            database: branchDb.database,
          },
          connectionString: branchDb.connectionString,
        }),
      };
    },
  );

  router.register(
    "GET",
    "/v1/projects/:slug/branches",
    async ({ headers, params }) => {
      // Branch list is project-scoped data: require credentials AND ownership.
      // The presence check runs after the guard so unauthenticated callers can't
      // probe project existence via 404s. The list carries NO secrets.
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const branches = await store.listBranches(project.id);
      return { status: 200, body: ok({ branches }) };
    },
  );

  router.register(
    "DELETE",
    "/v1/projects/:slug/branches/:name",
    async ({ headers, params }) => {
      if (!(await guardMutation(headers))) return unauthorized();
      const slug = params.slug!;
      const name = params.name!;
      if (!isValidBranchName(name)) {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "invalid branch name",
            "name must match ^[a-z0-9][a-z0-9_]{0,49}$",
          ),
        };
      }
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }
      const access = await authorizeProject(headers, project);
      if (access === "unauth") return unauthorized();
      if (access === "forbidden") return forbidden();
      const branch = await store.getBranchByName(project.id, name);
      if (!branch) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown branch: " + name),
        };
      }

      // Drop the branch's Postgres DB + scoped role. Best-effort + idempotent
      // (DROP ... IF EXISTS), so a missing/already-dropped DB never blocks
      // removing the control-plane row.
      try {
        await dropBranchDatabase({
          adminConnectionString: opts.adminConnectionString,
          database: branch.database,
          role: branch.role ?? undefined,
        });
      } catch {
        // Ignore: the database may never have been created or already dropped.
      }
      await store.deleteBranch(project.id, name);

      return { status: 200, body: ok({ deleted: name }) };
    },
  );

  // Handle POST /v1/projects/:slug/deploy-upload. The request body is a gzipped
  // tarball of the build context streamed directly to disk (never buffered) with
  // a hard MAX_UPLOAD_BYTES guard (413 on overflow). Secure-by-default ladder,
  // identical in spirit to the local-path /deploy handler:
  //   (1) guardMutation  -> 401 if no valid API key / bearer token
  //   (2) getProjectBySlug -> 404 if unknown (after the guard, so an
  //       unauthenticated caller cannot probe project existence)
  //   (3) authorizeProject -> 401/403 ownership ladder
  // Then stream -> extract (path-traversal + symlink audit) -> build. The temp
  // upload dir is ALWAYS removed in extractAndBuild's finally.
  async function handleDeployUpload(
    req: IncomingMessage,
    res: ServerResponse,
    input: {
      slug: string;
      appSubpath: string | null;
      containerPort: string | null;
      branchName: string | null;
    },
  ): Promise<void> {
    // Reject helper for the pre-stream checks (auth/ownership/validation). We
    // must NOT destroy the request before responding — doing so resets the
    // connection and the client sees a "socket hang up" instead of our JSON.
    // Instead we DRAIN the incoming body (resume + discard) so the request
    // completes cleanly, then send the JSON response. The client may still be
    // uploading; draining lets the socket finish without buffering anything.
    const reject = (status: number, body: unknown) => {
      req.on("error", () => {
        // ignore: client may abort once it sees the response
      });
      req.resume(); // discard any (further) request body
      sendJson(res, status, body);
    };

    // (1) Credentials.
    if (!(await guardMutation(req.headers))) {
      return reject(401, unauthorized().body);
    }

    // Validate appSubpath (query param) with the SAME whitelist as /deploy.
    let appSubpath: string | undefined;
    if (input.appSubpath !== null && input.appSubpath !== "") {
      const subpath = input.appSubpath;
      const safe =
        subpath.length > 0 &&
        !subpath.startsWith("/") &&
        /^[A-Za-z0-9._/-]+$/.test(subpath) &&
        !subpath.split("/").some((seg) => seg === "..");
      if (!safe) {
        return reject(
          400,
          fail(
            "E_BAD_ARGS",
            "invalid appSubpath",
            "appSubpath must be a safe relative path with no .. segments",
          ),
        );
      }
      appSubpath = subpath;
    }

    // Container port: default 3000, must be an integer in 1..65535.
    let containerPort = 3000;
    if (input.containerPort !== null) {
      const n = Number(input.containerPort);
      if (
        !/^\d+$/.test(input.containerPort) ||
        !Number.isInteger(n) ||
        n < 1 ||
        n > 65535
      ) {
        return reject(
          400,
          fail(
            "E_BAD_ARGS",
            "containerPort must be an integer between 1 and 65535",
            "?containerPort=3000",
          ),
        );
      }
      containerPort = n;
    }

    // (2) Resolve project (after the guard).
    const project = await store.getProjectBySlug(input.slug);
    if (!project) {
      return reject(
        404,
        fail("E_NOT_FOUND", "unknown project: " + input.slug),
      );
    }

    // (3) Ownership.
    const access = await authorizeProject(req.headers, project);
    if (access === "unauth") return reject(401, unauthorized().body);
    if (access === "forbidden") return reject(403, forbidden().body);

    // (4) Optional preview target: when ?branchName is present this is a preview
    // deploy against that DB branch (its own URL, branch-scoped DATABASE_URL).
    // Resolve it BEFORE streaming so a bad branch fails fast without an upload.
    let previewKind: string | undefined;
    let previewBranchId: string | undefined;
    let previewBranchName: string | undefined;
    let previewExtraEnv: Record<string, string> | undefined;
    if (input.branchName !== null && input.branchName !== "") {
      if (!isValidBranchName(input.branchName)) {
        return reject(
          400,
          fail(
            "E_BAD_ARGS",
            "invalid branchName",
            "branchName must match ^[a-z0-9][a-z0-9_]{0,49}$ (no '--')",
          ),
        );
      }
      const branch = await store.getBranchByName(project.id, input.branchName);
      if (!branch) {
        return reject(
          404,
          fail(
            "E_NOT_FOUND",
            "unknown branch: " + input.branchName,
            "create it first: podkit cloud branches create " +
              input.slug +
              " " +
              input.branchName,
          ),
        );
      }
      const branchConn = await store.getBranchConnectionString(branch.id);
      if (!branchConn) {
        return reject(
          400,
          fail("E_BRANCH_FAILED", "branch has no stored connection string"),
        );
      }
      previewKind = "preview";
      previewBranchId = branch.id;
      previewBranchName = input.branchName;
      previewExtraEnv = { DATABASE_URL: branchConn };
    }

    // Create a fresh per-upload directory under the (projectId-scoped) builds
    // root. mkdtemp guarantees a unique name so concurrent uploads never collide.
    let extractParent: string;
    let tarPath: string;
    try {
      const projectRoot = join(uploadsRoot, project.id);
      mkdirSync(projectRoot, { recursive: true });
      extractParent = mkdtempSync(join(projectRoot, "upload-"));
      tarPath = join(extractParent, "upload.tar.gz");
    } catch {
      return reject(
        500,
        fail("E_UNKNOWN", "could not prepare the upload directory"),
      );
    }

    // Stream the body to disk with the bounded size guard. On overflow we emit a
    // 413 and clean up the (now-orphaned) upload dir.
    try {
      await streamUploadToFile(req, tarPath, MAX_UPLOAD_BYTES);
    } catch (err) {
      try {
        rmSync(extractParent, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code === "E_PAYLOAD_TOO_LARGE") {
        return reject(
          413,
          fail(
            "E_PAYLOAD_TOO_LARGE",
            "upload exceeds the maximum allowed size",
            "exclude node_modules/.git/.podkit/dist, or split the upload",
          ),
        );
      }
      return reject(400, fail("E_BAD_ARGS", "upload failed"));
    }

    // Extract (with traversal/symlink audit) and build. extractAndBuild ALWAYS
    // cleans up extractParent in its finally.
    let result: DeployResult;
    try {
      result = await extractAndBuild({
        tarPath,
        extractParent,
        slug: input.slug,
        projectId: project.id,
        containerPort,
        appSubpath,
        kind: previewKind,
        branchId: previewBranchId,
        branchName: previewBranchName,
        extraEnv: previewExtraEnv,
      });
    } catch (err) {
      // Defensive: extractAndBuild already cleans up, but guard against an
      // unexpected throw so we never leak the temp dir or a stack trace.
      // Log the real error server-side (the client only gets a generic 500) so
      // a failed deploy is diagnosable instead of silently swallowed.
      console.error("[podkit] deploy-upload failed for " + input.slug + ":", err);
      try {
        rmSync(extractParent, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      return sendJson(res, 500, fail("E_UNKNOWN", "internal server error"));
    }

    if ("error" in result) {
      return sendJson(
        res,
        result.error.status,
        fail(result.error.code, result.error.message, result.error.hint),
      );
    }
    const routeKey = previewBranchName
      ? input.slug + "--" + previewBranchName
      : input.slug;
    return sendJson(
      res,
      200,
      ok({
        version: result.version,
        hostPort: result.hostPort,
        branchName: previewBranchName,
        url: gatewayUrl + "/_p/" + routeKey + "/",
      }),
    );
  }

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS: the cloud console is a separate origin from the control-plane.
      if (allowedOrigins === null) {
        // No allowlist configured: preserve the permissive wildcard default.
        res.setHeader("access-control-allow-origin", "*");
      } else {
        const requestOrigin = Array.isArray(req.headers.origin)
          ? req.headers.origin[0]
          : req.headers.origin;
        const resolved = resolveCorsHeader(requestOrigin, allowedOrigins);
        if (resolved.vary) res.setHeader("vary", "Origin");
        if (resolved.origin !== null) {
          res.setHeader("access-control-allow-origin", resolved.origin);
        }
      }
      res.setHeader(
        "access-control-allow-headers",
        "content-type, x-podkit-key, authorization",
      );
      res.setHeader(
        "access-control-allow-methods",
        "GET, POST, DELETE, OPTIONS",
      );
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";

        // Static console serving: GET requests that are not API or gateway paths.
        if (
          consoleDir !== undefined &&
          method === "GET" &&
          !url.pathname.startsWith("/v1/") &&
          !url.pathname.startsWith("/_p/")
        ) {
          const rawPath = url.pathname === "/" ? "/index.html" : url.pathname;
          // Security: resolve and verify the joined path stays within consoleDir.
          const safePath = resolve(join(consoleDir, rawPath));
          if (!safePath.startsWith(consoleDir + "/") && safePath !== consoleDir) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          const ext = extname(safePath);
          if (existsSync(safePath)) {
            try {
              const stat = statSync(safePath);
              res.statusCode = 200;
              res.setHeader("content-type", mimeForExt(ext));
              res.setHeader("content-length", stat.size);
              createReadStream(safePath).pipe(res);
            } catch {
              res.statusCode = 500;
              res.end("Internal Server Error");
            }
            return;
          }
          // SPA fallback: no extension => serve index.html.
          if (ext === "") {
            const indexPath = resolve(join(consoleDir, "index.html"));
            if (existsSync(indexPath)) {
              try {
                const stat = statSync(indexPath);
                res.statusCode = 200;
                res.setHeader("content-type", "text/html");
                res.setHeader("content-length", stat.size);
                createReadStream(indexPath).pipe(res);
              } catch {
                res.statusCode = 500;
                res.end("Internal Server Error");
              }
              return;
            }
          }
          // Asset not found (has an extension).
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        // Rate limit the API surface (not the console static assets above, nor
        // the gateway which is a separate server). Keyed by the presented
        // credential, falling back to the client IP for unauthenticated calls.
        if (url.pathname.startsWith("/v1/")) {
          const authH = req.headers["authorization"];
          const keyH = req.headers["x-podkit-key"];
          const rlKey =
            (Array.isArray(authH) ? authH[0] : authH) ||
            (Array.isArray(keyH) ? keyH[0] : keyH) ||
            req.socket.remoteAddress ||
            "anon";
          if (!checkApiRateLimit(rlKey)) {
            sendJson(
              res,
              429,
              fail("E_RATE_LIMITED", "rate limit exceeded, slow down"),
            );
            return;
          }
        }

        // Upload-based deploy is handled OUTSIDE the JSON router because the body
        // is a (potentially large) gzipped tarball, not JSON: it must NOT go
        // through readJson (1 MiB cap + full in-memory buffering). We stream it
        // straight to disk with a bounded size guard, extract it safely, and
        // build from the extracted dir. Matched by method + path shape.
        const uploadMatch =
          method === "POST"
            ? /^\/v1\/projects\/([^/]+)\/deploy-upload$/.exec(url.pathname)
            : null;
        if (uploadMatch) {
          await handleDeployUpload(req, res, {
            slug: decodeURIComponent(uploadMatch[1]!),
            appSubpath: url.searchParams.get("appSubpath"),
            containerPort: url.searchParams.get("containerPort"),
            branchName: url.searchParams.get("branchName"),
          });
          return;
        }

        // Read a JSON body for any method that carries one (POST/PUT/PATCH/DELETE);
        // GET/HEAD never do. readJson resolves {} for an empty body, so bodyless
        // DELETEs are unaffected. (deploy-upload is handled above and never reaches here.)
        const body =
          method === "GET" || method === "HEAD" ? undefined : await readJson(req);
        const m = router.match(method, url.pathname);
        if (!m) {
          sendJson(res, 404, fail("E_NOT_FOUND", "not found: " + url.pathname));
          return;
        }
        const r = await m.handler({
          params: m.params,
          query: url.searchParams,
          body,
          headers: req.headers,
        });
        sendJson(res, r.status, r.body);
      } catch (err) {
        console.error(
          "API error:",
          err instanceof Error ? err.stack : String(err),
        );
        sendJson(res, 500, fail("E_UNKNOWN", "internal server error"));
      }
    },
  );

  return {
    async listen(listenOpts: {
      apiPort: number;
      gatewayPort: number;
    }): Promise<{ apiUrl: string; gatewayUrl: string }> {
      await store.migrate();

      // Ensure the vendored base image exists BEFORE the server accepts deploys,
      // so the first standalone one-click deploy doesn't race a missing base.
      // Idempotent and non-fatal (logs on failure; standalone deploys fail fast
      // later with a clear error, other deploy paths are unaffected).
      await ensureBaseImage();

      // Hydrate the in-memory domain -> slug map from persisted custom domains.
      const allDomains = await store.listAllDomains();
      for (const { domain, slug } of allDomains) {
        domainMap.set(domain, slug);
      }

      const gw = await gateway.listen(listenOpts.gatewayPort);
      gatewayUrl = gw.url;

      const apiUrl = await new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenOpts.apiPort, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          const actualPort =
            typeof addr === "object" && addr ? addr.port : listenOpts.apiPort;
          resolve("http://localhost:" + actualPort);
        });
      });

      return { apiUrl, gatewayUrl };
    },

    async close(): Promise<void> {
      for (const name of runningContainers) {
        try {
          await stopContainer(name);
        } catch {
          // Ignore: container may already be gone.
        }
      }
      await gateway.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    },
  };
}
