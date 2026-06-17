import { describe, it, expect } from "vitest";
import { buildContainerEnv } from "../src/host.ts";

// Regression for the EROFS pglite crash: every container-start path (deploy,
// cold-start wake, rollback) routes its env through buildContainerEnv. The bug
// was that the wake/rollback re-runs dropped DATABASE_URL, so the woken app fell
// back to an embedded pglite that mkdir'd into the read-only container FS.
describe("buildContainerEnv — DATABASE_URL is never dropped on a re-run", () => {
  it("injects DATABASE_URL when the project has a provisioned DB", () => {
    const env = buildContainerEnv("postgres://db", []);
    expect(env.DATABASE_URL).toBe("postgres://db");
  });

  it("omits DATABASE_URL only when there is genuinely no DB url", () => {
    expect(buildContainerEnv(null, [])).not.toHaveProperty("DATABASE_URL");
  });

  it("lets a user-set env var override the managed DATABASE_URL", () => {
    const env = buildContainerEnv("postgres://managed", [
      { key: "DATABASE_URL", value: "postgres://user" },
      { key: "FOO", value: "bar" },
    ]);
    expect(env.DATABASE_URL).toBe("postgres://user");
    expect(env.FOO).toBe("bar");
  });

  it("lets extraEnv (e.g. a preview branch DB) win over both", () => {
    const env = buildContainerEnv(
      "postgres://managed",
      [{ key: "DATABASE_URL", value: "postgres://user" }],
      { DATABASE_URL: "postgres://branch" },
    );
    expect(env.DATABASE_URL).toBe("postgres://branch");
  });
});
