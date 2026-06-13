import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// Atomic pointer write: write to a temp file then rename (atomic on the same
// filesystem) so a crash or concurrent read never observes a torn `current`.
function setCurrent(deploysRoot: string, id: string): void {
  mkdirSync(deploysRoot, { recursive: true });
  const tmp = currentFile(deploysRoot) + ".tmp";
  writeFileSync(tmp, id);
  renameSync(tmp, currentFile(deploysRoot));
}

// The distinct promotion timeline (order of first occurrence). Used to walk
// rollback back through every prior version, not just toggle the two newest.
function distinctHistory(deploysRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of readHistory(deploysRoot)) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
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
  setCurrent(deploysRoot, id);
  // Append to the promotion log, deduping consecutive duplicates so re-promoting
  // the same version doesn't bloat history or break rollback.
  const history = readHistory(deploysRoot);
  if (history[history.length - 1] !== id) {
    history.push(id);
    writeFileSync(historyFile(deploysRoot), JSON.stringify(history));
  }
}

export function getCurrent(deploysRoot: string): string | null {
  const file = currentFile(deploysRoot);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

export function rollback(deploysRoot: string): { from: string | null; to: string } {
  const current = getCurrent(deploysRoot);
  const timeline = distinctHistory(deploysRoot);

  // Walk back one step through the distinct promotion timeline. Repeated
  // rollbacks keep moving toward older versions (not toggling the two newest).
  const idx = current === null ? -1 : timeline.indexOf(current);
  const to = idx > 0 ? timeline[idx - 1] : undefined;

  if (to === undefined) {
    throw new Error("no previous version");
  }

  setCurrent(deploysRoot, to);
  return { from: current, to };
}
