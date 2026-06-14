import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, createReadStream, statSync, realpathSync } from "node:fs";
import { join, resolve, extname, relative, isAbsolute, sep } from "node:path";
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
import {
  provisionDatabase,
  dropDatabase,
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

  // Resolved once listen() binds the gateway, used to build public URLs.
  let gatewayUrl = "";

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
      return hostPort ? { hostPort } : null;
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
    const userCode = randomBytes(4).toString("hex");
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
        logs = await containerLogs(target.containerId);
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
