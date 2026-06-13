import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeProject } from "../src/project.ts";

const helloRoot = fileURLToPath(
  new URL("../../../examples/hello", import.meta.url),
);

describe("describeProject", () => {
  it("introspects the example app", () => {
    const desc = describeProject({ appRoot: helloRoot });

    expect(Array.isArray(desc.routes)).toBe(true);
    expect(desc.routes.length).toBeGreaterThan(0);
    expect(desc.routes).toContainEqual(
      expect.objectContaining({ pattern: "/" }),
    );

    expect(desc.hasDb).toBe(true);
  });

  it("returns empty structural probe for an empty app root", () => {
    const empty = mkdtempSync(join(tmpdir(), "podkit-docs-empty-"));
    const desc = describeProject({ appRoot: empty });

    expect(desc).toEqual({ routes: [], hasDb: false, hasAuth: false });
  });
});
