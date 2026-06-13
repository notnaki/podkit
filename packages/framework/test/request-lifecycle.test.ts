import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { signToken } from "@podkit/auth";
import { createSink } from "@podkit/telemetry";
import { createDevServer } from "../src/server/dev-server.ts";

const appRoot = fileURLToPath(new URL("../../../examples/hello", import.meta.url));
const eventsFile = join(appRoot, ".podkit/telemetry/events.jsonl");

let server: Awaited<ReturnType<typeof createDevServer>>;
let base: string;
const prevSecret = process.env.PODKIT_AUTH_SECRET;

beforeAll(async () => {
  rmSync(eventsFile, { force: true });
  process.env.PODKIT_AUTH_SECRET = "itest-secret";
  server = await createDevServer({ appRoot, port: 0 });
  base = await server.listen();
});

afterAll(async () => {
  await server.close();
  if (prevSecret === undefined) delete process.env.PODKIT_AUTH_SECRET;
  else process.env.PODKIT_AUTH_SECRET = prevSecret;
});

describe("request lifecycle", () => {
  it("resolves identity from a bearer token and exposes it to the loader", async () => {
    const token = signToken({ userId: "u1", kind: "session" }, "itest-secret");
    const res = await fetch(`${base}/me`, {
      headers: { Authorization: "Bearer " + token },
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("me: u1");
  });

  it("renders null identity when no auth header is present", async () => {
    const res = await fetch(`${base}/me`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("me: null");
  });

  it("appends a request log event for the /me route", async () => {
    const events = createSink({ file: eventsFile }).all();
    expect(events.some((e) => e.route === "/me")).toBe(true);
  });
});
