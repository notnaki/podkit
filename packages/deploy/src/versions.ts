import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function versionsDir(deploysRoot: string): string {
  return join(deploysRoot, "versions");
}

function currentFile(deploysRoot: string): string {
  return join(deploysRoot, "current");
}

function historyFile(deploysRoot: string): string {
  return join(deploysRoot, "history.json");
}

function readHistory(deploysRoot: string): string[] {
  const file = historyFile(deploysRoot);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

export function publishVersion(opts: {
  artifactDir: string;
  deploysRoot: string;
  id: string;
}): { id: string; path: string } {
  const dest = join(versionsDir(opts.deploysRoot), opts.id);
  cpSync(opts.artifactDir, dest, { recursive: true });
  return { id: opts.id, path: dest };
}

export function listVersions(deploysRoot: string): string[] {
  const dir = versionsDir(deploysRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function promote(deploysRoot: string, id: string): void {
  if (!existsSync(join(versionsDir(deploysRoot), id))) {
    throw new Error("unknown version: " + id);
  }
  mkdirSync(deploysRoot, { recursive: true });
  writeFileSync(currentFile(deploysRoot), id);
  const history = readHistory(deploysRoot);
  history.push(id);
  writeFileSync(historyFile(deploysRoot), JSON.stringify(history));
}

export function getCurrent(deploysRoot: string): string | null {
  const file = currentFile(deploysRoot);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

export function rollback(deploysRoot: string): { from: string | null; to: string } {
  const history = readHistory(deploysRoot);
  const current = getCurrent(deploysRoot);

  // Find the second-to-last DISTINCT entry: the last distinct value that differs
  // from the most recent (current) one.
  let to: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry !== undefined && entry !== current) {
      to = entry;
      break;
    }
  }

  if (to === null) {
    throw new Error("no previous version");
  }

  writeFileSync(currentFile(deploysRoot), to);
  return { from: current, to };
}
