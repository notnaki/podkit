import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  // names of app containers we started, so close() can tear them down.
  const runningContainers: string[] = [];

  // Resolved once listen() binds the gateway, used to build public URLs.
  let gatewayUrl = "";

  const gateway = createGateway({
    resolve: ({ path }) => {
      const slug = slugFromPath(path);
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
      const { id, hostPort } = await runContainer({
        image: tag,
        name,
        containerPort: b.containerPort,
      });
      runningContainers.push(name);

      await store.recordDeployment({
        projectId: project.id,
        version,
        containerId: id,
        hostPort,
        status: "running",
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

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS: the cloud console is a separate origin from the control-plane.
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader(
        "access-control-allow-headers",
        "content-type, x-podkit-key, authorization",
      );
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";
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
