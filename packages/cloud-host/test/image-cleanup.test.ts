import { describe, it, expect, vi, afterEach } from "vitest";

// Proves the per-suite Docker image cleanup logic: it lists images, removes ONLY
// the tags matching the given repository prefix, and is best-effort (never throws
// when docker listing or removal fails). The helper under test is structurally
// identical to the inline `cleanupImages` added to host/rollback/logs/cross-tenant
// suites; here we re-create it bound to a mocked docker so it runs without a daemon.

interface ExecCall {
  cmd: string;
  args: string[];
}

// Build a cleanupImages bound to a fake `docker` exec. `imagesOutput` is the
// stdout `docker images --format ...` would print; `failListing`/`failRmi` force
// the corresponding docker invocations to reject so we can assert non-fatal-ness.
function makeCleanup(opts: {
  imagesOutput: string;
  failListing?: boolean;
  failRmi?: boolean;
  calls: ExecCall[];
}): (repositoryPrefix: string) => Promise<void> {
  const execFileAsync = async (
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    opts.calls.push({ cmd, args });
    if (args[0] === "images") {
      if (opts.failListing) throw new Error("daemon down");
      return { stdout: opts.imagesOutput, stderr: "" };
    }
    if (args[0] === "rmi") {
      if (opts.failRmi) throw new Error("image in use");
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  return async function cleanupImages(repositoryPrefix: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "images",
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
      const toRemove = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((img) => img.startsWith(repositoryPrefix));
      for (const tag of toRemove) {
        try {
          await execFileAsync("docker", ["rmi", "-f", tag]);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  };
}

describe("E2E image cleanup helper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes only images matching the suite's repository prefix", async () => {
    const calls: ExecCall[] = [];
    const cleanup = makeCleanup({
      calls,
      imagesOutput: [
        "podkit-demo:v11112222",
        "podkit-demo:v33334444",
        "podkit-secok:v55556666", // different prefix -> must NOT be removed
        "podkit-rb:vaaaabbbb", // sibling suite -> must NOT be removed
        "node:22-alpine", // unrelated base image -> must NOT be removed
        "", // blank line tolerated
      ].join("\n"),
    });

    await cleanup("podkit-demo:v");

    const removed = calls
      .filter((c) => c.args[0] === "rmi")
      .map((c) => c.args[c.args.length - 1]);
    expect(removed).toEqual(["podkit-demo:v11112222", "podkit-demo:v33334444"]);
  });

  it("does not throw when docker image listing fails (best-effort)", async () => {
    const calls: ExecCall[] = [];
    const cleanup = makeCleanup({
      calls,
      imagesOutput: "podkit-lg:v00001111",
      failListing: true,
    });

    await expect(cleanup("podkit-lg:v")).resolves.toBeUndefined();
    // Listing failed, so no removal should have been attempted.
    expect(calls.some((c) => c.args[0] === "rmi")).toBe(false);
  });

  it("does not throw when an individual rmi fails (image in use)", async () => {
    const calls: ExecCall[] = [];
    const cleanup = makeCleanup({
      calls,
      imagesOutput: "podkit-rb:vdeadbeef\npodkit-rb:vfeedface",
      failRmi: true,
    });

    await expect(cleanup("podkit-rb:v")).resolves.toBeUndefined();
    // Both matching images were attempted despite the rejection.
    const attempted = calls
      .filter((c) => c.args[0] === "rmi")
      .map((c) => c.args[c.args.length - 1]);
    expect(attempted).toEqual(["podkit-rb:vdeadbeef", "podkit-rb:vfeedface"]);
  });

  it("removes nothing when no image matches the prefix", async () => {
    const calls: ExecCall[] = [];
    const cleanup = makeCleanup({
      calls,
      imagesOutput: "podkit-demo:v1\npodkit-rb:v2",
    });

    await cleanup("podkit-xt-abc123:v");

    expect(calls.some((c) => c.args[0] === "rmi")).toBe(false);
  });
});
