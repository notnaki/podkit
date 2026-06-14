import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Regression test for the active-deployment detection bug in GET
// /v1/projects/:slug/logs. listDeployments returns oldest-first and mixes
// kinds: a preview teardown appends a kind="stopped" row with containerId=""
// to the SAME per-project history. After "deploy production, then stop a
// preview", that stopped marker is the LAST row. The buggy code picked the
// last row as the active deployment, set target.containerId="" and returned
// empty logs for an app that is still running. The fix scans newest -> oldest
// for the most recent deploy/rollback (findActiveDeployment), matching the
// sibling /deployments and DELETE endpoints.
//
// We mock @podkit/runtime (so containerLogs echoes the container id it was
// asked about — no Docker) and @podkit/cloud-store (so listDeployments returns
// a history whose last row is a stopped preview marker), then drive the logs
// route and assert it targeted the RUNNING production container.

// The container id the host asked docker logs about, captured so we can prove
// the endpoint selected the production deploy and not the stopped marker.
let loggedContainerId = "";

vi.mock("@podkit/runtime", () => ({
  DEFAULT_BASE_IMAGE: "podkit-base:latest",
  buildImage: vi.fn(async () => {}),
  runContainer: vi.fn(async () => ({ id: "unused", hostPort: 0 })),
  stopContainer: vi.fn(async () => {}),
  containerLogs: vi.fn(async (containerId: string) => {
    loggedContainerId = containerId;
    return "log-from:" + containerId;
  }),
  isPodkitApp: vi.fn(async () => false),
  buildPodkitApp: vi.fn(async () => {}),
}));

// In-memory store. The production deploy ("prod-container") is followed by a
// preview deploy and then its teardown marker (kind="stopped", containerId="")
// — so the LAST row is the stopped marker, which must NOT be treated as active.
vi.mock("@podkit/cloud-store", () => {
  const notImplemented = (name: string) => () => {
    throw new Error("store." + name + " not stubbed");
  };
  return {
    createStore: () => ({
      migrate: async () => {},
      listAllDomains: async () => [],
      getProjectBySlug: async (slug: string) =>
        slug === "act" ? { id: "proj-1", slug: "act", owner: "me" } : null,
      // oldest-first; last row is a stopped preview teardown marker.
      listDeployments: async (projectId: string) =>
        projectId === "proj-1"
          ? [
              {
                id: "dep-prod",
                version: "v1",
                hostPort: 54321,
                status: "running",
                containerPort: 3000,
                containerId: "prod-container",
                kind: "deploy",
                branchId: null,
                createdAt: "2026-06-13T00:00:00Z",
              },
              {
                id: "dep-preview",
                version: "v2",
                hostPort: 54322,
                status: "running",
                containerPort: 3000,
                containerId: "preview-container",
                kind: "preview",
                branchId: "branch-1",
                createdAt: "2026-06-13T01:00:00Z",
              },
              {
                id: "dep-stopped",
                version: "v2",
                hostPort: 0,
                status: "stopped",
                containerPort: 3000,
                containerId: "",
                kind: "stopped",
                branchId: "branch-1",
                createdAt: "2026-06-13T02:00:00Z",
              },
            ]
          : [],
      getDeploymentById: notImplemented("getDeploymentById"),
      listEnv: notImplemented("listEnv"),
      setProjectDbUrl: notImplemented("setProjectDbUrl"),
      getProjectDbUrl: notImplemented("getProjectDbUrl"),
    }),
  };
});

const { createCloud } = await import("../src/host.ts");

let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";

beforeAll(async () => {
  cloud = createCloud({
    controlPlaneConnectionString: "postgres://unused",
    adminConnectionString: "postgres://unused",
    apiKey: "k",
  });
  const urls = await cloud.listen({ apiPort: 0, gatewayPort: 0 });
  apiUrl = urls.apiUrl;
});

afterAll(async () => {
  if (cloud) {
    try {
      await cloud.close();
    } catch {
      // ignore
    }
  }
});

describe("GET /logs active-deployment detection ignores stopped preview markers", () => {
  it(
    "returns the running production deployment's logs, not the last (stopped) row",
    async () => {
      loggedContainerId = "";

      const res = await fetch(apiUrl + "/v1/projects/act/logs", {
        headers: { "x-podkit-key": "k" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.ok).toBe(true);
      // Active deployment must be the production deploy, NOT the stopped marker.
      expect(body.data.deploymentId).toBe("dep-prod");
      expect(body.data.version).toBe("v1");
      // The endpoint asked docker logs about the production container...
      expect(loggedContainerId).toBe("prod-container");
      // ...and returned its logs rather than the empty string the buggy path
      // produced when target.containerId was "" (the stopped marker).
      expect(body.data.logs).toBe("log-from:prod-container");
    },
    30000,
  );
});
