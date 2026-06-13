import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { createStore } from "@podkit/cloud-store";
import {
  buildImage,
  runContainer,
  stopContainer,
} from "@podkit/runtime";
import { createGateway } from "@podkit/gateway";
import { provisionDatabase } from "@podkit/db-provision";
import {
  requireApiKey,
  createRouter,
  sendJson,
  readJson,
} from "@podkit/cloud";

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

  const guard = (
    headers: Record<string, string | string[] | undefined>,
  ): { status: number; body: unknown } | null => {
    if (!requireApiKey(headers, apiKey)) {
      return {
        status: 401,
        body: fail(
          "E_UNAUTHORIZED",
          "missing or invalid x-podkit-key",
          "set the x-podkit-key header",
        ),
      };
    }
    return null;
  };

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
    const denied = guard(headers);
    if (denied) return denied;
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
      const denied = guard(headers);
      if (denied) return denied;
      const slug = params.slug!;
      const b = (body ?? {}) as {
        contextDir?: string;
        containerPort?: number;
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

      await buildImage({ contextDir: b.contextDir, tag });
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
      res.setHeader("access-control-allow-headers", "content-type, x-podkit-key");
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
