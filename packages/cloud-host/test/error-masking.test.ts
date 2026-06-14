import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// A recognizable secret-like message that must NEVER reach the client.
const SECRET_MESSAGE =
  "connect ECONNREFUSED postgres://user:pw@db.internal:5432/secret";

// Mock the heavy infra deps so we can boot the control-plane host without
// Docker/Postgres and exercise the global error-handling path in isolation.
vi.mock("@podkit/cloud-store", () => ({
  createStore: () => ({
    async migrate() {},
    async listAllDomains() {
      return [];
    },
    // The GET /v1/projects route calls this first; throw a secret-bearing
    // error to verify the server masks it before responding.
    async listProjects(): Promise<never> {
      throw new Error(SECRET_MESSAGE);
    },
    async close() {},
  }),
}));

vi.mock("@podkit/gateway", () => ({
  createGateway: () => ({
    async listen() {
      return { url: "http://localhost:0" };
    },
    async close() {},
  }),
}));

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
    await cloud.close();
  }
});

describe("control-plane error masking", () => {
  it("returns a generic 500 and never leaks the thrown error message", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await fetch(apiUrl + "/v1/projects", {
      headers: { "x-podkit-key": "k" },
    });
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("internal server error");

    // The secret must not appear anywhere in the serialized response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET_MESSAGE);
    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain("ECONNREFUSED");

    // But it must still be logged server-side for debugging.
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("API error:");
    expect(logged).toContain(SECRET_MESSAGE);

    errSpy.mockRestore();
  });
});
