import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDbClient } from "../src/client.ts";
import type { DbClient } from "../src/client.ts";
import { pgTable, text, integer, uuidPk } from "../src/schema.ts";
import { createRestHandler } from "../src/rest/handler.ts";

const posts = pgTable("posts", {
  id: uuidPk(),
  title: text("title").notNull(),
  views: integer("views"),
});

// Minimal IncomingMessage stand-in: an EventEmitter that emits the body chunks
// when listeners attach, exposing the method/url the handler reads.
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  (req as { resume: () => void }).resume = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

interface CapturedRes {
  res: ServerResponse;
  done: Promise<{ status: number; json: unknown }>;
}

function mockRes(): CapturedRes {
  let resolve!: (v: { status: number; json: unknown }) => void;
  const done = new Promise<{ status: number; json: unknown }>((r) => (resolve = r));
  const res: ServerResponse = {
    statusCode: 200,
    setHeader() {},
    end(payload?: string) {
      resolve({
        status: (res as ServerResponse).statusCode,
        json: payload ? JSON.parse(payload) : undefined,
      });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

describe("createRestHandler", () => {
  let client: DbClient;

  beforeAll(async () => {
    client = createDbClient();
    await client.raw(
      `create table posts (id uuid primary key default gen_random_uuid(), title text not null, views integer)`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  const handler = () => createRestHandler(client, posts, { basePath: "/api/posts" });

  async function call(method: string, url: string, body?: unknown) {
    const { res, done } = mockRes();
    const handled = await handler()(mockReq(method, url, body), res);
    expect(handled).toBe(true);
    return done;
  }

  it("inserts a row (POST) and lists it (GET)", async () => {
    const created = await call("POST", "/api/posts", { title: "hello", views: 3 });
    expect(created.status).toBe(201);
    const row = (created.json as { data: { id: string; title: string; views: number } }).data;
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.title).toBe("hello");
    expect(row.views).toBe(3);

    const list = await call("GET", "/api/posts?limit=10");
    expect(list.status).toBe(200);
    const data = (list.json as { data: unknown[]; limit: number }).data;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect((list.json as { limit: number }).limit).toBe(10);
  });

  it("fetches one by id and 404s for a missing id", async () => {
    const created = await call("POST", "/api/posts", { title: "findme" });
    const id = (created.json as { data: { id: string } }).data.id;

    const got = await call("GET", `/api/posts/${id}`);
    expect(got.status).toBe(200);
    expect((got.json as { data: { title: string } }).data.title).toBe("findme");

    const missing = await call("GET", "/api/posts/00000000-0000-0000-0000-000000000000");
    expect(missing.status).toBe(404);
  });

  it("rejects unknown columns with 400 (whitelist)", async () => {
    const bad = await call("POST", "/api/posts", { title: "x", evil: "DROP TABLE" });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toContain("unknown column");
  });

  it("rejects a missing required column with 400", async () => {
    const bad = await call("POST", "/api/posts", { views: 1 });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toContain("missing required column");
  });

  it("rejects attempts to set the primary key", async () => {
    const bad = await call("POST", "/api/posts", {
      id: "11111111-1111-1111-1111-111111111111",
      title: "x",
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: string }).error).toContain("primary key");
  });

  it("rejects a non-object body", async () => {
    const bad = await call("POST", "/api/posts", [1, 2, 3]);
    expect(bad.status).toBe(400);
  });

  it("updates by id (PATCH) and 404s for a missing id", async () => {
    const created = await call("POST", "/api/posts", { title: "before" });
    const id = (created.json as { data: { id: string } }).data.id;

    const updated = await call("PATCH", `/api/posts/${id}`, { title: "after" });
    expect(updated.status).toBe(200);
    expect((updated.json as { data: { title: string } }).data.title).toBe("after");

    const missing = await call("PATCH", "/api/posts/00000000-0000-0000-0000-000000000000", {
      title: "z",
    });
    expect(missing.status).toBe(404);
  });

  it("deletes by id and 404s the second time", async () => {
    const created = await call("POST", "/api/posts", { title: "doomed" });
    const id = (created.json as { data: { id: string } }).data.id;

    const del = await call("DELETE", `/api/posts/${id}`);
    expect(del.status).toBe(200);

    const again = await call("DELETE", `/api/posts/${id}`);
    expect(again.status).toBe(404);
  });

  it("returns 405 for an unsupported method", async () => {
    const r = await call("OPTIONS", "/api/posts");
    expect(r.status).toBe(405);
  });
});
