import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RouteKind } from "../types.ts";

/**
 * A single route entry in the production build manifest. Mirrors a discovered
 * Route, but additionally records the pre-compiled SSR module file name so the
 * prod server can dynamically import it without Vite.
 */
export interface BuildManifestRoute {
  pattern: string;
  kind: RouteKind;
  /** Source route file, relative to app/routes (e.g. "blog/[slug].tsx"). */
  file: string;
  params: string[];
  /** SSR-compiled module file relative to serverDir (e.g. "blog/[slug]-SSR.js"). */
  serverFile: string;
}

/**
 * The production build manifest. Written to <outDir>/build-manifest.json by
 * buildApp and read back by createProdServer.
 */
export interface BuildManifest {
  routes: BuildManifestRoute[];
  /** Client asset directory relative to the build dir (always "client"). */
  clientDir: string;
  /** SSR module directory relative to the build dir (always "server"). */
  serverDir: string;
  /** Hashed client entry path served to the browser (e.g. "/client/entry-AbC123.js"). */
  clientEntry: string;
}

export function writeManifest(path: string, manifest: BuildManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

export function readManifest(path: string): BuildManifest {
  return JSON.parse(readFileSync(path, "utf8")) as BuildManifest;
}
