import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createRouter, sendJson, readJson } from "../src/router.ts";

const ok = () => ({ status: 200, body: { ok: true } });

describe("createRouter", () => {
  it("matches a static route with empty params", () => {
    const r = createRouter();
    const h1 = ok;
    r.register("GET", "/v1/health", h1);
    const m = r.match("GET", "/v1/health");
    expect(m?.handler).toBe(h1);
    expect(m?.params).toEqual({});
  });

  it("matches a param route and extracts the param", () => {
    const r = createRouter();
    const h2 = ok;
    r.register("GET", "/v1/docs/:topic", h2);
    const m = r.match("GET", "/v1/docs/routing");
    expect(m?.handler).toBe(h2);
    expect(m?.params).toEqual({ topic: "routing" });
  });

  it("returns null when the method does not match", () => {
    const r = createRouter();
    r.register("GET", "/v1/health", ok);
    expect(r.match("POST", "/v1/health")).toBeNull();
  });

  it("matches the method case-insensitively", () => {
    const r = createRouter();
    const h1 = ok;
    r.register("get", "/v1/health", h1);
    const m = r.match("GeT", "/v1/health");
    expect(m?.handler).toBe(h1);
  });

  it("returns null when no route matches", () => {
    const r = createRouter();
    r.register("GET", "/v1/health", ok);
    expect(r.match("GET", "/nope")).toBeNull();
  });

  it("returns null when segment counts differ", () => {
    const r = createRouter();
    r.register("GET", "/v1/docs/:topic", ok);
    expect(r.match("GET", "/v1/docs")).toBeNull();
    expect(r.match("GET", "/v1/docs/routing/extra")).toBeNull();
  });

  it("distinguishes routes that share a prefix", () => {
    const r = createRouter();
    const h1 = ok;
    const h2 = () => ({ status: 201, body: null });
    r.register("GET", "/v1/health", h1);
    r.register("GET", "/v1/docs/:topic", h2);
    expect(r.match("GET", "/v1/health")?.handler).toBe(h1);
    expect(r.match("GET", "/v1/docs/x")?.handler).toBe(h2);
  });
});

describe("sendJson", () => {
  it("captures status, content-type header, and serialized body", () => {
    const headers: Record<string, unknown> = {};
    let ended: string | undefined;
    const res = {
      statusCode: 0,
      setHeader(k: string, v: unknown) {
        headers[k] = v;
      },
      end(s: string) {
        ended = s;
      },
    };
    sendJson(res, 201, { hello: "world" });
    expect(res.statusCode).toBe(201);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(ended).toBe(JSON.stringify({ hello: "world" }));
  });
});

describe("readJson", () => {
  it("parses a JSON body from the stream", async () => {
    const req = Readable.from([JSON.stringify({ a: 1 })]);
    await expect(readJson(req)).resolves.toEqual({ a: 1 });
  });

  it("resolves {} for an empty stream", async () => {
    const req = Readable.from([]);
    await expect(readJson(req)).resolves.toEqual({});
  });

  it("rejects on a stream error", async () => {
    const req = new Readable({ read() {} });
    const p = readJson(req);
    req.destroy(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
  });
});
