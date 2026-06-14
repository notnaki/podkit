import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, createReadStream, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { createStore } from "@podkit/cloud-store";
import {
  buildImage,
  runContainer,
  stopContainer,
  isPodkitApp,
  buildPodkitApp,
} from "@podkit/runtime";
import { createGateway } from "@podkit/gateway";
import { provisionDatabase } from "@podkit/db-provision";
import {
  requireApiKey,
  createRouter,
  sendJson,
  readJson,
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
};

export type Cloud = {
  listen: (opts: {
    apiPort: number;
    gatewayPort: number;
  }) => Promise<{ apiUrl: string; gatewayUrl: string }>;
  close: () => Promise<void>;
};

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

export function createCloud(opts: CreateCloudOptions): Cloud {
  const store = createStore({
    connectionString: opts.controlPlaneConnectionString,
  });
  const apiKey = opts.apiKey;
  const consoleDir = opts.consoleDir ? resolve(opts.consoleDir) : undefined;
  // Secret used to sign/verify account (and CLI) bearer tokens.
  const authSecret = resolveAuthSecret();

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

  router.register("GET", "/v1/health", () => ({
    status: 200,
    body: ok({ status: "ok" }),
  }));

  router.register("GET", "/v1/projects", async () => {
    // Enrich each project with its latest deployment + routed URL so the
    // console can render Vercel-style cards (domain + status) without N fetches.
    const projects = await store.listProjects();
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const deps = await store.listDeployments(p.id);
        const latest = deps[deps.length - 1] ?? null;
        return {
          ...p,
          version: latest ? latest.version : null,
          status: latest ? latest.status : null,
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
    const project = await store.createProject({
      slug: b.slug,
      owner: b.owner ?? "",
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
      const project = await store.getProjectBySlug(slug);
      if (!project) {
        return {
          status: 404,
          body: fail("E_NOT_FOUND", "unknown project: " + slug),
        };
      }

      const version = "v" + randomBytes(4).toString("hex");
      const tag = "podkit-" + slug + ":" + version;
      const name = "podkit-app-" + slug + "-" + randomBytes(3).toString("hex");

      // Build the image: an explicit Dockerfile wins; otherwise, if it's a
      // podkit app (has app/routes), the buildpack generates one — zero-config.
      const appDir = b.appSubpath ? join(b.contextDir, b.appSubpath) : b.contextDir;
      if (existsSync(join(appDir, "Dockerfile"))) {
        await buildImage({ contextDir: appDir, tag });
      } else if (isPodkitApp(appDir)) {
        await buildPodkitApp({
          repoRoot: b.contextDir,
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
      { accountId: account.id, email: account.email },
      authSecret,
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
      { accountId: account.id, email: account.email },
      authSecret,
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
      { accountId: auth.accountId, cli: true },
      authSecret,
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

  router.register("GET", "/v1/projects/:slug", async ({ params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
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

  router.register("GET", "/v1/projects/:slug/deployments", async ({ params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
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

  router.register("GET", "/v1/projects/:slug/env", async ({ params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
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

  router.register("GET", "/v1/projects/:slug/domains", async ({ params }) => {
    const slug = params.slug!;
    const project = await store.getProjectBySlug(slug);
    if (!project) {
      return {
        status: 404,
        body: fail("E_NOT_FOUND", "unknown project: " + slug),
      };
    }
    return {
      status: 200,
      body: ok({ domains: await store.listDomains(project.id) }),
    };
  });

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
      await store.deleteDomain({ projectId: project.id, domain });
      domainMap.delete(domain);
      return { status: 200, body: ok({ deleted: domain }) };
    },
  );

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS: the cloud console is a separate origin from the control-plane.
      res.setHeader("access-control-allow-origin", "*");
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
        sendJson(
          res,
          500,
          fail("E_UNKNOWN", err instanceof Error ? err.message : String(err)),
        );
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
