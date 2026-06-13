import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GenerateMigrationOptions {
  schemaPath: string;
  outDir: string;
  name?: string;
}

export interface GenerateMigrationResult {
  file: string;
}

function findNewestSqlFile(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const abs = join(dir, f);
      return { path: abs, mtimeMs: statSync(abs).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (files.length === 0) {
    throw new Error(`No .sql files found in ${dir}`);
  }

  return files[0].path;
}

function resolveDrizzleKit(): string {
  // Try to find drizzle-kit binary relative to this file's location.
  // The package is at packages/db, so node_modules/.bin/drizzle-kit lives there.
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  // Walk up to find the package root (packages/db)
  const candidates = [
    join(thisDir, "../../node_modules/.bin/drizzle-kit"),
    join(thisDir, "../../../node_modules/.bin/drizzle-kit"),
    join(thisDir, "../../../../node_modules/.bin/drizzle-kit"),
    "drizzle-kit",
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return candidate;
    } catch {
      // continue
    }
  }

  return "drizzle-kit";
}

export async function generateMigration(
  opts: GenerateMigrationOptions
): Promise<GenerateMigrationResult> {
  const { schemaPath, outDir, name } = opts;
  const absSchema = resolve(schemaPath);
  const absOut = resolve(outDir);

  const drizzleKit = resolveDrizzleKit();

  const args = [
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    absSchema,
    "--out",
    absOut,
  ];

  if (name !== undefined) {
    args.push("--name", name);
  }

  execFileSync(drizzleKit, args, {
    stdio: "pipe",
    env: { ...process.env },
  });

  const file = findNewestSqlFile(absOut);
  return { file };
}
