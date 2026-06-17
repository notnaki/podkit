import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initCommand } from "../src/commands/init.ts";

const origCwd = process.cwd();
let tmp = "";

afterEach(() => {
  process.chdir(origCwd);
  if (tmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    tmp = "";
  }
});

describe("podkit init", () => {
  it("scaffolds a new app into ./<name>", async () => {
    tmp = mkdtempSync(join(tmpdir(), "podkit-init-"));
    process.chdir(tmp);

    const res = await initCommand(["my-app"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { name: string; path: string; files: string[] };
    expect(data.name).toBe("my-app");

    const appDir = join(tmp, "my-app");
    for (const f of [
      "package.json",
      "app/routes/index.tsx",
      "app/routes/about.tsx",
      ".gitignore",
      "README.md",
    ]) {
      expect(existsSync(join(appDir, f)), f).toBe(true);
    }
    // The framework owns the client hydration entry — apps don't scaffold one.
    expect(existsSync(join(appDir, "app/entry-client.tsx"))).toBe(false);

    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@podkit/framework"]).toBeTruthy();
    expect(pkg.scripts.dev).toBe("podkit dev");

    // The generated route is a valid podkit module: default component + loader.
    const idx = readFileSync(join(appDir, "app/routes/index.tsx"), "utf8");
    expect(idx).toContain("export default function");
    expect(idx).toContain("export function loader");
  });

  it("rejects an invalid app name", async () => {
    tmp = mkdtempSync(join(tmpdir(), "podkit-init-"));
    process.chdir(tmp);
    const res = await initCommand(["Not Valid!"]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("E_BAD_ARGS");
  });

  it("refuses to overwrite existing files", async () => {
    tmp = mkdtempSync(join(tmpdir(), "podkit-init-"));
    process.chdir(tmp);
    const first = await initCommand(["dup"]);
    expect(first.ok).toBe(true);
    // Re-running in place targets the same dir -> existing package.json blocks it.
    const second = await initCommand(["dup"]);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("E_BAD_STATE");
  });
});
