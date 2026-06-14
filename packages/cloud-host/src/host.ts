import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, createReadStream, statSync, realpathSync } from "node:fs";
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
} from "@podkit/runtime";
import { createGateway } from "@podkit/gateway";
import { createMetricsRegistry } from "@podkit/telemetry";
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

  // slug -> current host port of the live container for that project.
  const routeMap = new Map<string, number>();
  // custom domain (hostname, no port) -> project slug.
  const domainMap = new Map<string, string>();
  // names of app containers we started, so close() can tear them down.
  const runningContainers: string[] = [];
  // slug -> name of the container currently serving it, so a new deploy/rollback
  // can reap the one it superseded (otherwise dead containers leak until close).
  const activeContainer = new Map<string, string>();

  // Make `name` the live container for `slug` and stop the one it replaced.
  // Called AFTER routeMap is switched, so the old container is already off the
  // routing path — reaping it only reclaims resources, never drops traffic.
  async function reapSuperseded(slug: string, name: string): Promise<void> {
    const prev = activeContainer.get(slug);
    activeContainer.set(slug, name);
    if (prev && prev !== name) {
      const idx = runningContainers.indexOf(prev);
      if (idx !== -1) runningContainers.splice(idx, 1);
      try {
        await stopContainer(prev);
      } catch {
        // Best-effort: the old container may already be gone.
      }
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
      const hostPort = routeMap.get(slug);
      // Thread the resolved slug out so onRequest can attribute the request.
      return hostPort ? { hostPort, slug } : null;
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
      // Validate + resolve the build context to a real on-disk path, rejecting
      // system directories, the control-plane source, and (when configured)
      // anything outside the builds sandbox. Defense-in-depth alongside the
      // appSubpath whitelist above and Docker's own filesystem isolation.
      const ctx = validateContextDir(b.contextDir, controlPlaneRoot, buildsRoot);
      if ("error" in ctx) {
        return {
          status: 400,
          body: fail(ctx.error.code, ctx.error.message, ctx.error.hint),
        };
      }
      const contextDir = ctx.path;
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

      const version = "v" + randomBytes(4).toString("hex");
      const tag = "podkit-" + slug + ":" + version;
      const name = "podkit-app-" + slug + "-" + randomBytes(3).toString("hex");

      // Build the image: an explicit Dockerfile wins; otherwise, if it's a
      // podkit app (has app/routes), the buildpack generates one — zero-config.
      const appDir = b.appSubpath ? join(contextDir, b.appSubpath) : contextDir;
      if (existsSync(join(appDir, "Dockerfile"))) {
        await buildImage({ contextDir: appDir, tag });
      } else if (isPodkitApp(appDir)) {
        await buildPodkitApp({
          repoRoot: contextDir,
          appSubpath: b.appSubpath ?? ".",
          tag,
          port: b.containerPort,
        });
      } else {
        return {
          status: 400,
          body: fail(
            "E_BAD_ARGS",
            "no Dockerfile and not a podkit app",
            "add a Dockerfile, or deploy a podkit app (with app/routes)",
          ),
        };
      }
      // Inject the project's environment variables into the container.
      const envRows = await store.listEnv(project.id);
      const env: Record<string, string> = {};
      for (const row of envRows) {
        env[row.key] = row.value;
      }

      const { id, hostPort } = await runContainer({
        image: tag,
        name,
        containerPort: b.containerPort,
        env,
      });
      runningContainers.push(name);

      await store.recordDeployment({
        projectId: project.id,
        version,
        containerId: id,
        hostPort,
        status: "running",
        containerPort: b.containerPort,
        kind: "deploy",
      });
      routeMap.set(slug, hostPort);
      await reapSuperseded(slug, name);

      return {
        status: 200,
        body: ok({
          version,
          hostPort,
          url: gatewayUrl + "/_p/" + slug + "/",
        }),
      };
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

      // Stop the active container (the most recent deployment) if any. Best
      // effort: a pruned/already-stopped container must not block teardown.
      const deployments = await store.listDeployments(project.id);
      const active = deployments[deployments.length - 1];
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
    // store returns oldest-first; the most recent is the live/active one.
    const deployments = await store.listDeployments(project.id);
    const activeId =
      deployments.length > 0 ? deployments[deployments.length - 1]!.id : null;
    // Present newest-first and flag which one is currently serving traffic.
    const items = deployments
      .slice()
      .reverse()
      .map((d) => ({
        id: d.id,
        version: d.version,
        status: d.status,
        kind: d.kind,
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
      const deployments = await store.listDeployments(project.id);
      const active = deployments[deployments.length - 1];
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
      await store.recordDeployment({
        projectId: project.id,
        version: target.version,
        containerId: started.id,
        hostPort: started.hostPort,
        status: "running",
        containerPort: target.containerPort,
        kind: "rollback",
      });
      routeMap.set(slug, started.hostPort);
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
    async ({ headers, params, body }) => {
      // Read-only SQL runner. Same guard ladder as the logs/env handlers: the
      // mutation guard runs first so unauthenticated callers can't probe project
      // existence via 404s, then ownership is enforced. The query itself runs as
      // the per-project SCOPED non-superuser role (never adminConnectionString),
      // so even a parser bypass cannot reach another tenant's database.
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
        scopedConnectionString = await store.getProjectDbUrl(project.id);
        if (!scopedConnectionString) {
          const provisioned = await provisionDatabase({
            adminConnectionString: opts.adminConnectionString,
            slug,
          });
          scopedConnectionString = provisioned.connectionString;
          await store.setProjectDbUrl(project.id, scopedConnectionString);
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

        const body = method === "POST" ? await readJson(req) : undefined;
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
