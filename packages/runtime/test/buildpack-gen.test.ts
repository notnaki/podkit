import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { generatePodkitDockerfile, isPodkitApp } from "../src/index.ts";

const helloAppDir = fileURLToPath(new URL("../../../examples/hello", import.meta.url));

describe("buildpack generator", () => {
  it("detects the example podkit app", () => {
    expect(isPodkitApp(helloAppDir)).toBe(true);
  });

  it("does not detect an empty directory as a podkit app", () => {
    const empty = mkdtempSync(join(tmpdir(), "podkit-bp-empty-"));
    expect(isPodkitApp(empty)).toBe(false);
  });

  it("generates a monorepo Dockerfile for the app", () => {
    const dockerfile = generatePodkitDockerfile({ appSubpath: "examples/hello", port: 3000 });
    expect(dockerfile).toContain("FROM node:22");
    expect(dockerfile).toContain("pnpm install");
    expect(dockerfile).toContain("WORKDIR /app/examples/hello");
    expect(dockerfile).toContain(
      'CMD ["node","/app/packages/cli/src/bin.ts","dev","--port","3000"]',
    );
  });
});
