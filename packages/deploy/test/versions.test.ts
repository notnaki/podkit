import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishVersion,
  listVersions,
  promote,
  getCurrent,
  rollback,
} from "../src/versions.ts";

let deploysRoot: string;
let artifactV1: string;
let artifactV2: string;

beforeAll(() => {
  deploysRoot = mkdtempSync(join(tmpdir(), "podkit-deploys-"));
  artifactV1 = mkdtempSync(join(tmpdir(), "podkit-artifact-v1-"));
  artifactV2 = mkdtempSync(join(tmpdir(), "podkit-artifact-v2-"));
  writeFileSync(join(artifactV1, "app.txt"), "v1");
  writeFileSync(join(artifactV2, "app.txt"), "v2");
});

afterAll(() => {
  rmSync(deploysRoot, { recursive: true, force: true });
  rmSync(artifactV1, { recursive: true, force: true });
  rmSync(artifactV2, { recursive: true, force: true });
});

describe("versions", () => {
  it("publishes versions and copies artifacts", () => {
    const r1 = publishVersion({ artifactDir: artifactV1, deploysRoot, id: "v1" });
    const r2 = publishVersion({ artifactDir: artifactV2, deploysRoot, id: "v2" });
    expect(r1).toEqual({ id: "v1", path: join(deploysRoot, "versions", "v1") });
    expect(r2).toEqual({ id: "v2", path: join(deploysRoot, "versions", "v2") });
  });

  it("lists versions sorted ascending", () => {
    expect(listVersions(deploysRoot)).toEqual(["v1", "v2"]);
  });

  it("promotes and reports current", () => {
    promote(deploysRoot, "v1");
    promote(deploysRoot, "v2");
    expect(getCurrent(deploysRoot)).toBe("v2");
  });

  it("throws when promoting unknown version", () => {
    expect(() => promote(deploysRoot, "nope")).toThrow("unknown version: nope");
  });

  it("rolls back to previous distinct version", () => {
    const result = rollback(deploysRoot);
    expect(result).toEqual({ from: "v2", to: "v1" });
    expect(getCurrent(deploysRoot)).toBe("v1");
  });
});

describe("versions on empty root", () => {
  it("listVersions returns [] when none", () => {
    const empty = mkdtempSync(join(tmpdir(), "podkit-empty-"));
    expect(listVersions(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it("getCurrent returns null when no current", () => {
    const empty = mkdtempSync(join(tmpdir(), "podkit-empty2-"));
    expect(getCurrent(empty)).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});
