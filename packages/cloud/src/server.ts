import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  buildArtifact,
  publishVersion,
  listVersions,
  getCurrent,
  promote,
  rollback,
  initDeploy,
  readDeploy,
} from "@podkit/deploy";
import { issueAgentToken, resolveAuthSecret } from "@podkit/auth";
import { createSink, query, aggregate } from "@podkit/telemetry";
import { listTopics, getDoc, describeProject } from "@podkit/docs";
import { createRouter, sendJson, readJson } from "./router.ts";
import { requireApiKey } from "./apikey.ts";
import { parseCorsOrigins, resolveCorsHeader } from "./cors.ts";

function ok(data: unknown) {
  return { ok: true, data };
}

function fail(code: string, message: string, hint?: string) {
  return { ok: false, error: { code, message, hint } };
}

export function createControlPlane(opts: {
  projectRoot?: string;
  apiKey?: string;
  corsOrigin?: string;
  corsOrigins?: string;
}): { listen(port: number): Promise<{ url: string }>; close(): Promise<void> } {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const deploysRoot = join(projectRoot, ".podkit/deploys");
  const artifactsRoot = join(projectRoot, ".podkit/artifacts");
  const eventsFile = join(projectRoot, ".podkit/telemetry/events.jsonl");
  const apiKey = opts.apiKey ?? process.env.PODKIT_API_KEY;
  // Refuses to run in production without PODKIT_AUTH_SECRET (no forgeable
  // tokens signed with a public default); warns + dev-default otherwise.
  const authSecret = resolveAuthSecret();

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

  router.register("GET", "/v1/docs", () => ({
    status: 200,
    body: ok({ topics: listTopics() }),
  }));

  router.register("GET", "/v1/docs/:topic", ({ params }) => {
    const d = getDoc(params.topic!);
    return d
      ? { status: 200, body: ok(d) }
      : {
          status: 404,
          body: fail("E_BAD_ARGS", "unknown topic: " + params.topic, "GET /v1/docs"),
        };
  });

  router.register("GET", "/v1/project", () => ({
    status: 200,
    body: ok(describeProject({ appRoot: projectRoot })),
  }));

  router.register("GET", "/v1/deployments", () => ({
    status: 200,
    body: ok({ versions: listVersions(deploysRoot), current: getCurrent(deploysRoot) }),
  }));

  router.register("GET", "/v1/logs", () => ({
    status: 200,
    body: ok({ events: query(createSink({ file: eventsFile }).all(), { kind: "log" }) }),
  }));

  router.register("GET", "/v1/analytics", () => ({
    status: 200,
    body: ok({ counts: aggregate(createSink({ file: eventsFile }).all()) }),
  }));

  router.register("POST", "/v1/auth/token", ({ headers, body }) => {
    const denied = guard(headers);
    if (denied) return denied;
    const b = (body ?? {}) as { userId?: string; scopes?: string[] };
    if (!b.userId) {
      return { status: 400, body: fail("E_BAD_ARGS", "userId required") };
    }
    return {
      status: 200,
      body: ok({
        token: issueAgentToken({ userId: b.userId, scopes: b.scopes ?? [] }, authSecret),
      }),
    };
  });

  router.register("POST", "/v1/deploy", ({ headers }) => {
    const denied = guard(headers);
    if (denied) return denied;
    const id = "v" + randomBytes(6).toString("hex");
    buildArtifact({
      appRoot: projectRoot,
      outDir: join(artifactsRoot, id),
      builtAt: Date.now(),
    });
    publishVersion({ artifactDir: join(artifactsRoot, id), deploysRoot, id });
    initDeploy(deploysRoot, "dep_" + randomBytes(6).toString("hex"));
    promote(deploysRoot, id);
    return {
      status: 200,
      body: ok({
        versionId: id,
        deployId: readDeploy(deploysRoot)?.deployId,
        current: getCurrent(deploysRoot),
      }),
    };
  });

  router.register("POST", "/v1/rollback", ({ headers }) => {
    const denied = guard(headers);
    if (denied) return denied;
    return { status: 200, body: ok(rollback(deploysRoot)) };
  });

  // Optional CORS allowlist. When PODKIT_CORS_ORIGINS (or opts.corsOrigins) is
  // set, only those Origins are reflected; otherwise we keep the legacy static
  // value (opts.corsOrigin, default "*") for backward compatibility.
  const corsOriginsInput =
    opts.corsOrigins ?? process.env.PODKIT_CORS_ORIGINS ?? undefined;
  const allowedOrigins = parseCorsOrigins(corsOriginsInput);
  const staticCorsOrigin = opts.corsOrigin ?? "*";

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS: the dashboard is a separate origin from the control-plane.
    const requestOrigin = Array.isArray(req.headers.origin)
      ? req.headers.origin[0]
      : req.headers.origin;
    if (allowedOrigins === null) {
      // No allowlist: preserve the historic static behavior.
      res.setHeader("access-control-allow-origin", staticCorsOrigin);
    } else {
      const resolved = resolveCorsHeader(requestOrigin, allowedOrigins);
      if (resolved.vary) res.setHeader("vary", "Origin");
      if (resolved.origin !== null) {
        res.setHeader("access-control-allow-origin", resolved.origin);
      }
    }
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
        sendJson(res, 404, fail("E_BAD_ARGS", "not found: " + url.pathname));
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
      if (err && typeof err === "object" && (err as { code?: unknown }).code === "E_PAYLOAD_TOO_LARGE") {
        sendJson(res, 413, fail("E_PAYLOAD_TOO_LARGE", "request body too large"));
        return;
      }
      sendJson(res, 500, fail("E_UNKNOWN", err instanceof Error ? err.message : String(err)));
    }
  });

  return {
    listen(port: number): Promise<{ url: string }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolve({ url: "http://localhost:" + actualPort });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
