import { cpSync, mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { buildRouteTable } from "@podkit/framework";

export interface BuildArtifactOptions {
  appRoot: string;
  outDir: string;
  builtAt: number;
}

export interface ArtifactManifest {
  routes: unknown[];
  builtAt: number;
}

export interface BuildArtifactResult {
  outDir: string;
  manifest: ArtifactManifest;
}

function listFiles(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, root));
    } else {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out;
}

export function buildArtifact(opts: BuildArtifactOptions): BuildArtifactResult {
  const { appRoot, outDir, builtAt } = opts;

  mkdirSync(outDir, { recursive: true });

  cpSync(join(appRoot, "app"), join(outDir, "app"), { recursive: true });

  const routesDir = join(appRoot, "app", "routes");
  const routes = buildRouteTable(listFiles(routesDir));

  const manifest: ArtifactManifest = { routes, builtAt };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return { outDir, manifest };
}
