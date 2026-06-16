import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  generatePodkitDockerfile,
  generateStandalonePodkitDockerfile,
  isPodkitApp,
  DEFAULT_BASE_IMAGE,
} from "../src/index.ts";

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
      'CMD ["node","/app/packages/cli/src/bin.ts","start","--port","3000"]',
    );
  });

  it("sets NODE_ENV=production for the runtime", () => {
    const dockerfile = generatePodkitDockerfile({ appSubpath: "examples/hello", port: 3000 });
    expect(dockerfile).toContain("ENV NODE_ENV=production");
  });

  it("generates a Dockerfile that drops to the non-root node user", () => {
    const dockerfile = generatePodkitDockerfile({ appSubpath: "examples/hello", port: 3000 });
    expect(dockerfile).toContain("RUN chown -R node:node /app");
    expect(dockerfile).toContain("USER node");
    // USER must come after the chown (so root can hand off ownership) and
    // before CMD (so the app process runs unprivileged).
    expect(dockerfile.indexOf("RUN chown -R node:node /app")).toBeLessThan(
      dockerfile.indexOf("USER node"),
    );
    expect(dockerfile.indexOf("USER node")).toBeLessThan(dockerfile.indexOf("CMD ["));
  });
});

describe("standalone buildpack generator", () => {
  it("builds FROM the vendored base image by default", () => {
    const dockerfile = generateStandalonePodkitDockerfile({ appSubpath: ".", port: 3000 });
    expect(dockerfile).toContain(`FROM ${DEFAULT_BASE_IMAGE} AS builder`);
    expect(dockerfile).toContain(`FROM ${DEFAULT_BASE_IMAGE} AS runtime`);
    // It must NOT re-derive from node:22 (that's the monorepo generator) — the
    // whole point is to reuse the preinstalled @podkit/* from the base.
    expect(dockerfile).not.toContain("FROM node:22");
  });

  it("honors a custom base image (PODKIT_BASE_IMAGE override)", () => {
    const dockerfile = generateStandalonePodkitDockerfile({
      appSubpath: ".",
      port: 3000,
      baseImage: "my-registry/podkit-base:v1.2.3",
    });
    expect(dockerfile).toContain("FROM my-registry/podkit-base:v1.2.3 AS builder");
    expect(dockerfile).toContain("FROM my-registry/podkit-base:v1.2.3 AS runtime");
    expect(dockerfile).not.toContain("podkit-base:latest");
  });

  it("grafts the app into the base workspace and installs from the workspace root", () => {
    const dockerfile = generateStandalonePodkitDockerfile({ appSubpath: ".", port: 3000 });
    // The app is grafted under the base's apps/* glob so workspace:* deps resolve.
    expect(dockerfile).toContain("WORKDIR /app/apps/_standalone");
    // Install runs from the workspace root (/app), not the app dir, so pnpm sees
    // the @podkit/* packages and the grafted app together.
    expect(dockerfile).toContain("cd /app && pnpm install --no-frozen-lockfile");
    // Build + start reuse the base image's CLI.
    expect(dockerfile).toContain(
      "node /app/packages/cli/src/bin.ts build --appRoot /app/apps/_standalone",
    );
  });

  it("drops to the non-root node user before CMD", () => {
    const dockerfile = generateStandalonePodkitDockerfile({ appSubpath: ".", port: 3000 });
    expect(dockerfile).toContain("USER node");
    expect(dockerfile.indexOf("RUN chown -R node:node /app")).toBeLessThan(
      dockerfile.indexOf("USER node"),
    );
    expect(dockerfile.indexOf("USER node")).toBeLessThan(dockerfile.indexOf("CMD ["));
    expect(dockerfile).toContain(
      'CMD ["node","/app/packages/cli/src/bin.ts","start","--port","3000"]',
    );
  });

  it("respects a custom port", () => {
    const dockerfile = generateStandalonePodkitDockerfile({ appSubpath: ".", port: 8080 });
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain('"--port","8080"');
  });

  it("sets NODE_ENV=production in the runtime stage", () => {
    const dockerfile = generateStandalonePodkitDockerfile({ appSubpath: ".", port: 3000 });
    expect(dockerfile).toContain("ENV NODE_ENV=production");
    // It belongs to the runtime stage, after the builder finishes.
    expect(dockerfile.indexOf("AS runtime")).toBeLessThan(dockerfile.indexOf("ENV NODE_ENV=production"));
  });
});
