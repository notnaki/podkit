import { describe, it, expect, afterAll } from "vitest";
import { createControlPlane } from "../src/server.ts";

const projectRoot = "/Users/nuh/Desktop/podkit-cloud/examples/hello";
const cp = createControlPlane({ projectRoot, apiKey: "test-key" });
const listening = await cp.listen(0);
const url = listening.url;

afterAll(async () => {
  await cp.close();
});

describe("createControlPlane", () => {
  it("GET /v1/health returns ok", async () => {
    const res = await fetch(`${url}/v1/health`);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("ok");
  });

  it("GET /v1/docs/routing returns the routing doc", async () => {
    const res = await fetch(`${url}/v1/docs/routing`);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.topic).toBe("routing");
  });

  it("GET /v1/docs/nope returns 404 E_BAD_ARGS", async () => {
    const res = await fetch(`${url}/v1/docs/nope`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("E_BAD_ARGS");
  });

  it("POST /v1/auth/token without key returns 401 E_UNAUTHORIZED", async () => {
    const res = await fetch(`${url}/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u1" }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("E_UNAUTHORIZED");
  });

  it("POST /v1/auth/token with key returns a token", async () => {
    const res = await fetch(`${url}/v1/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-podkit-key": "test-key",
      },
      body: JSON.stringify({ userId: "u1", scopes: ["read"] }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.data.token).toBe("string");
  });

  it("GET /v1/deployments returns versions array", async () => {
    const res = await fetch(`${url}/v1/deployments`);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.versions)).toBe(true);
  });
});
