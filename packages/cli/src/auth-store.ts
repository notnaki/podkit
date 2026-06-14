import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Auth = { url?: string; token?: string };

function authFilePath(): string {
  return process.env.PODKIT_AUTH_FILE ?? join(homedir(), ".podkit", "auth.json");
}

export function readAuth(): Auth | null {
  try {
    const raw = readFileSync(authFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Auth;
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeAuth(auth: Auth): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function clearAuth(): void {
  try {
    rmSync(authFilePath());
  } catch {
    // already absent
  }
}
