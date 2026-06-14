import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cloudCommand,
  formatTable,
  __setSpawnForTest,
} from "../src/commands/cloud.ts";

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
