import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudCommand } from "../src/commands/cloud.ts";
import { readAuth, writeAuth, clearAuth } from "../src/auth-store.ts";

let dir: string;
const prevAuthFile = process.env.PODKIT_AUTH_FILE;
const prevApiUrl = process.env.PODKIT_API_URL;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "podkit-auth-"));
  process.env.PODKIT_AUTH_FILE = join(dir, "auth.json");
});

afterEach(() => {
  clearAuth();
  if (prevAuthFile === undefined) {
    delete process.env.PODKIT_AUTH_FILE;
  } else {
    process.env.PODKIT_AUTH_FILE = prevAuthFile;
  }
  if (prevApiUrl === undefined) {
    delete process.env.PODKIT_API_URL;
  } else {
    process.env.PODKIT_API_URL = prevApiUrl;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("auth-store", () => {
  it("round-trips writeAuth + readAuth", () => {
    writeAuth({ url: "http://example.test", token: "tok-123" });
    const auth = readAuth();
    expect(auth).toEqual({ url: "http://example.test", token: "tok-123" });
  });

  it("clearAuth makes readAuth return null", () => {
    writeAuth({ url: "http://example.test", token: "tok-123" });
    clearAuth();
    expect(readAuth()).toBeNull();
  });

  it("readAuth returns null when no file exists", () => {
    expect(readAuth()).toBeNull();
  });
});

describe("cloud login/logout", () => {
  it("login returns E_NETWORK when the control-plane is unreachable", async () => {
    process.env.PODKIT_API_URL = "http://localhost:59999";
    const res = await cloudCommand(["login"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("E_NETWORK");
  });

  it("logout clears the saved auth", async () => {
    writeAuth({ url: "http://example.test", token: "tok-123" });
    const res = await cloudCommand(["logout"]);
    expect(res.ok).toBe(true);
    expect(readAuth()).toBeNull();
  });
});
