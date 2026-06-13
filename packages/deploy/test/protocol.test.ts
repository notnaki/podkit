import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDeploy, readDeploy, claimDeploy } from "../src/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "podkit-deploy-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("protocol", () => {
  it("initDeploy creates an unclaimed deploy", () => {
    expect(initDeploy(root, "dep_123")).toEqual({
      deployId: "dep_123",
      claimed: false,
    });
  });

  it("initDeploy returns the existing meta when one is present", () => {
    expect(initDeploy(root, "dep_999")).toEqual({
      deployId: "dep_123",
      claimed: false,
    });
  });

  it("claimDeploy sets claimed and owner", () => {
    expect(claimDeploy(root, "alice")).toEqual({
      deployId: "dep_123",
      claimed: true,
      owner: "alice",
    });
  });

  it("readDeploy returns the claimed meta", () => {
    expect(readDeploy(root)).toEqual({
      deployId: "dep_123",
      claimed: true,
      owner: "alice",
    });
  });

  it("readDeploy returns null when no deploy exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "podkit-deploy-empty-"));
    try {
      expect(readDeploy(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("claimDeploy throws on a fresh empty dir", () => {
    const empty = mkdtempSync(join(tmpdir(), "podkit-deploy-empty-"));
    try {
      expect(() => claimDeploy(empty, "bob")).toThrow("no deploy to claim");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
