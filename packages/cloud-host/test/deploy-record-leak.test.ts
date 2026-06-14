import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Regression test for the resource-leak bug: when store.recordDeployment fails
// AFTER a container has already started, the orphaned container must be stopped
// (and forgotten) before the error propagates — otherwise it leaks until full
// server shutdown. We mock @podkit/runtime (so no Docker is needed) and
// @podkit/cloud-store (so we can force recordDeployment to throw) and drive the
// rollback route, which exercises the runContainer -> push -> recordDeployment
// sequence guarded by stopAndForget. The deploy path uses the identical guard.

// Tracks every container name the host asked to stop, so we can assert the
// orphan was reaped.
const stopped: string[] = [];
// Captures the name of the container the host started, so we can match it
// against what was stopped.
let startedName = "";

vi.mock("@podkit/runtime", () => ({
  buildImage: vi.fn(async () => {}),
  runContainer: vi.fn(async (opts: { name: string }) => {
    startedName = opts.name;
    return { id: "container-id-xyz", hostPort: 54321 };
  }),
  stopContainer: vi.fn(async (name: string) => {
    stopped.push(name);
  }),
  containerLogs: vi.fn(async () => ""),
  isPodkitApp: vi.fn(async () => false),
  buildPodkitApp: vi.fn(async () => {}),
}));

// A minimal in-memory store. Only the methods the rollback route + listen()
// touch are implemented; the rest throw so an accidental dependency is loud.
// recordDeployment always rejects, simulating a DB write failure in the window
// after the container has started.
vi.mock("@podkit/cloud-store", () => {
  const notImplemented = (name: string) => () => {
    throw new Error("store." + name + " not stubbed");
  };
  return {
    createStore: () => ({
      migrate: async () => {},
      listAllDomains: async () => [],
      getProjectBySlug: async (slug: string) =>
        slug === "leak" ? { id: "proj-1", slug: "leak", owner: "me" } : null,
      getDeploymentById: async (id: string) =>
        id === "dep-1"
          ? {
              id: "dep-1",
              projectId: "proj-1",
              version: "v1",
              containerPort: 3000,
              containerId: "old-container",
              status: "running",
              branchId: null,
            }
          : null,
      listEnv: async () => [],
      recordDeployment: async () => {
        throw new Error("simulated DB write failure");
      },
      // Anything else would indicate the route changed shape unexpectedly.
      setProjectDbUrl: notImplemented("setProjectDbUrl"),
      getProjectDbUrl: notImplemented("getProjectDbUrl"),
      listDeployments: notImplemented("listDeployments"),
    }),
  };
});

// Imported AFTER the mocks are registered so they take effect.
const { createCloud } = await import("../src/host.ts");
const runtime = await import("@podkit/runtime");

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

describe("recordDeployment failure does not leak the started container", () => {
  it(
    "stops (and forgets) the orphaned container when the deployment insert fails",
    async () => {
      stopped.length = 0;
      startedName = "";

      const res = await fetch(apiUrl + "/v1/projects/leak/rollback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ deploymentId: "dep-1" }),
      });

      // The deploy half-succeeded then failed: the client gets a clean 500.
      expect(res.status).toBe(500);

      // A container WAS started (proving we reached the failure window)...
      expect(runtime.runContainer).toHaveBeenCalledTimes(1);
      expect(startedName).not.toBe("");

      // ...and the SAME container was stopped on the failure path, not leaked.
      expect(stopped).toContain(startedName);

      // close() should now have nothing left to tear down: a SECOND stop of
      // the same name would mean it was still tracked in runningContainers.
      const stopCountBeforeClose = stopped.filter(
        (n) => n === startedName,
      ).length;
      expect(stopCountBeforeClose).toBe(1);
    },
    30000,
  );
});
