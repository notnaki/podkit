import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  cloudCommand,
  formatTable,
  __setSpawnForTest,
} from "../src/commands/cloud.ts";

// Build a fake `tar` child process: a Readable stdout that emits a tiny gzip-ish
// payload then closes with the given exit code. stderr is a Readable too.
function fakeTar(exitCode: number, stdoutBytes: Buffer): any {
  const child = new EventEmitter() as any;
  child.stdout = Readable.from([stdoutBytes]);
  child.stderr = Readable.from([]);
  child.kill = () => {};
  // Emit close after stdout has been consumed (next tick).
  child.stdout.on("end", () => {
    setImmediate(() => child.emit("close", exitCode));
  });
  return child;
}

// Start a one-shot HTTP server that replies with `status` + `bodyJson` and
// drains the request body. Returns the base URL + a close fn.
function startStubServer(
  status: number,
  bodyJson: unknown,
): Promise<{ url: string; close: () => Promise<void>; received: () => number }> {
  let receivedBytes = 0;
  const server: Server = createServer((req, res) => {
    req.on("data", (c: Buffer) => {
      receivedBytes += c.length;
    });
    req.on("end", () => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(bodyJson));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({
        url: `http://localhost:${port}`,
        received: () => receivedBytes,
        close: () =>
          new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("cloudCommand argument validation", () => {
  it("rejects an unknown subcommand", async () => {
    const res = await cloudCommand(["bogus"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects a missing subcommand", async () => {
    const res = await cloudCommand([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects create without a slug", async () => {
    const res = await cloudCommand(["create"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects deploy without a slug", async () => {
    const res = await cloudCommand(["deploy"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("rejects url without a slug", async () => {
    const res = await cloudCommand(["url"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });
});

describe("formatTable", () => {
  it("produces an exact aligned, dashed-rule table", () => {
    const rows = [
      { slug: "demo", url: "https://demo.podkit.app" },
      { slug: "longer-slug", url: "https://x.io" },
    ];
    const expected = [
      "slug        | url                    ",
      "------------+------------------------",
      "demo        | https://demo.podkit.app",
      "longer-slug | https://x.io           ",
    ].join("\n");
    expect(formatTable(rows)).toBe(expected);
  });
});

describe("cloudCommand open", () => {
  afterEach(() => {
    __setSpawnForTest(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects open without a slug", async () => {
    const res = await cloudCommand(["open"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("opens the project URL in the browser and returns {status:'opened',url}", async () => {
    const url = "https://demo.podkit.app";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({ ok: true, data: { slug: "demo", url } }),
      })) as unknown as typeof fetch,
    );
    const spawnSpy = vi.fn(() => {
      const child = { on: () => child, unref: () => {} };
      return child as unknown as ReturnType<
        typeof import("node:child_process").spawn
      >;
    });
    __setSpawnForTest(spawnSpy as never);

    const res = await cloudCommand(["open", "demo"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ status: "opened", url });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(callArgs[1]).toContain(url);
  });

  it("fails with E_BAD_STATE when the project has no URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({ ok: true, data: { slug: "demo" } }),
      })) as unknown as typeof fetch,
    );
    const res = await cloudCommand(["open", "demo"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_STATE");
  });
});

describe("cloudCommand deploy (upload flow)", () => {
  // Point auth file at a nonexistent path so readAuth() returns null and
  // PODKIT_API_URL/PODKIT_API_KEY drive resolveBase()/authHeaders() — keeps the
  // test hermetic regardless of any real ~/.podkit/auth.json on the machine.
  beforeEach(() => {
    process.env.PODKIT_AUTH_FILE = "/nonexistent/podkit-test-auth.json";
  });
  afterEach(() => {
    __setSpawnForTest(null);
    delete process.env.PODKIT_API_URL;
    delete process.env.PODKIT_API_KEY;
    delete process.env.PODKIT_AUTH_FILE;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects deploy without a slug", async () => {
    const res = await cloudCommand(["deploy"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("tars the context and POSTs the gzip stream to /deploy-upload", async () => {
    const stub = await startStubServer(200, {
      ok: true,
      data: { version: "vabc", url: "http://gw/_p/demo/" },
    });
    process.env.PODKIT_API_URL = stub.url;
    process.env.PODKIT_API_KEY = "k";

    const payload = Buffer.from("FAKE_GZIP_TARBALL_BYTES");
    let spawnArgs: string[] = [];
    const spawnSpy = vi.fn((_cmd: string, args: string[]) => {
      spawnArgs = args;
      return fakeTar(0, payload);
    });
    __setSpawnForTest(spawnSpy as never);

    const res = await cloudCommand(["deploy", "demo"]);
    await stub.close();

    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as any).version).toBe("vabc");
    // tar was invoked to gzip the context with the standard excludes.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnArgs).toContain("-czf");
    expect(spawnArgs).toContain("--exclude=node_modules");
    expect(spawnArgs).toContain("--exclude=.git");
    // The server received the streamed tar bytes.
    expect(stub.received()).toBe(payload.length);
  });

  it("maps a 413 response to a friendly excludes hint", async () => {
    const stub = await startStubServer(413, {
      ok: false,
      error: { code: "E_PAYLOAD_TOO_LARGE", message: "too large" },
    });
    process.env.PODKIT_API_URL = stub.url;
    process.env.PODKIT_API_KEY = "k";
    __setSpawnForTest(
      vi.fn(() => fakeTar(0, Buffer.from("x"))) as never,
    );

    const res = await cloudCommand(["deploy", "demo"]);
    await stub.close();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("E_BAD_STATE");
      expect(String(res.error.hint)).toContain("node_modules");
    }
  });

  it("maps a 400 response to a repack hint with the server message", async () => {
    const stub = await startStubServer(400, {
      ok: false,
      error: { code: "E_BAD_ARGS", message: "tarball contains an absolute path entry" },
    });
    process.env.PODKIT_API_URL = stub.url;
    process.env.PODKIT_API_KEY = "k";
    __setSpawnForTest(
      vi.fn(() => fakeTar(0, Buffer.from("x"))) as never,
    );

    const res = await cloudCommand(["deploy", "demo"]);
    await stub.close();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("E_BAD_ARGS");
      expect(res.error.message).toContain("absolute path");
      expect(String(res.error.hint)).toContain("repack");
    }
  });

  it("fails when tar exits non-zero", async () => {
    const stub = await startStubServer(200, { ok: true, data: {} });
    process.env.PODKIT_API_URL = stub.url;
    process.env.PODKIT_API_KEY = "k";
    __setSpawnForTest(
      vi.fn(() => fakeTar(2, Buffer.from(""))) as never,
    );

    const res = await cloudCommand(["deploy", "demo"]);
    await stub.close();

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_BAD_STATE");
  });
});

describe("cloudCommand --table", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders status as a table and does not treat --table as the slug", async () => {
    const url = "https://demo.podkit.app";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const path = String(input);
        if (path.endsWith("/deployments")) {
          return {
            json: async () => ({
              ok: true,
              data: { deployments: [{ id: "d1", version: "v3" }] },
            }),
          };
        }
        if (path.endsWith("/env")) {
          return { json: async () => ({ ok: true, data: { env: [] } }) };
        }
        if (path.endsWith("/domains")) {
          return { json: async () => ({ ok: true, data: { domains: [] } }) };
        }
        // project lookup
        return {
          json: async () => ({ ok: true, data: { slug: "demo", url } }),
        };
      }) as unknown as typeof fetch,
    );

    const res = await cloudCommand(["status", "demo", "--table"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const table = res.data as unknown as string;
      expect(typeof table).toBe("string");
      expect(table).toContain(url);
      expect(table).toContain("v3");
      // proves --table was stripped: positional slug resolved to "demo"
      expect(table).toContain("demo");
    }
  });
});
