import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifact } from "../src/artifact.ts";

const appRoot = fileURLToPath(new URL("../../../examples/hello", import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), "podkit-artifact-"));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("buildArtifact", () => {
  it("copies the app tree and writes a manifest with routes", () => {
    const result = buildArtifact({ appRoot, outDir, builtAt: 1700000000000 });

    expect(existsSync(join(outDir, "app", "routes", "index.tsx"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as {
      routes: Array<{ pattern: string }>;
      builtAt: number;
    };
    expect(typeof manifest).toBe("object");
    expect(Array.isArray(manifest.routes)).toBe(true);
    expect(manifest.routes.length).toBeGreaterThan(0);
    expect(manifest.routes.some((r) => r.pattern === "/")).toBe(true);
    expect(manifest.builtAt).toBe(1700000000000);

    expect(result.outDir).toBe(outDir);
    expect(result.manifest.builtAt).toBe(1700000000000);
  });
});
