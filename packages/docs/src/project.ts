import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildRouteTable } from "@podkit/framework";

export interface ProjectDescription {
  routes: unknown[];
  hasDb: boolean;
  hasAuth: boolean;
}

function listFiles(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else out.push(relative(root, full));
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function describeProject(opts: { appRoot: string }): ProjectDescription {
  const { appRoot } = opts;

  const routesDir = join(appRoot, "app", "routes");
  const routes = existsSync(routesDir)
    ? buildRouteTable(listFiles(routesDir).map(toPosix))
    : [];

  const hasDb = existsSync(join(appRoot, "app", "db", "schema.ts"));
  const hasAuth = existsSync(join(appRoot, "app", "auth.ts"));

  return { routes, hasDb, hasAuth };
}
