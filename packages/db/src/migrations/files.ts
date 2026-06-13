import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function migrationFilename(timestamp: number, name: string): string {
  const paddedTimestamp = String(timestamp).padStart(13, "0");
  const sanitizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${paddedTimestamp}_${sanitizedName}.sql`;
}

export interface MigrationFile {
  id: string;
  name: string;
  path: string;
}

export function listMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  return files.map((file) => {
    const underscoreIndex = file.indexOf("_");
    const id = file.slice(0, underscoreIndex);
    const name = file.slice(underscoreIndex + 1, -".sql".length);
    return {
      id,
      name,
      path: join(dir, file),
    };
  });
}

export function readMigration(path: string): string {
  return readFileSync(path, "utf-8");
}
