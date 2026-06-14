import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        // Pre-compiled prod SSR route modules (emitted by buildApp) must be
        // loaded by Node's native ESM loader, not transformed by vite-node.
        external: [/-SSR\.js$/],
      },
    },
  },
});
