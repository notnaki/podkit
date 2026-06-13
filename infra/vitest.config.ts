import { defineConfig } from "vitest/config";

// Dedicated config for the infra compose test, which lives outside the
// monorepo's default `packages/**/test/**` include glob and drives real
// docker compose (slow; long timeouts).
export default defineConfig({
  test: {
    include: ["infra/**/*.test.ts"],
    environment: "node",
    testTimeout: 600000,
    hookTimeout: 600000,
  },
});
