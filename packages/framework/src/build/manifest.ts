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
  /** SSR-compiled `_layout` modules wrapping this route, outermost first. */
  layouts?: string[];
  /**
   * Prerendered static HTML file (relative to the build dir) for routes that
   * `export const prerender = true` and have no dynamic params. The prod server
   * serves this directly instead of rendering per request.
   */
  prerender?: string;
  /**
   * Concrete prerendered paths for a DYNAMIC route that `export const prerender
   * = true` and `export function getStaticPaths()`. Maps each resolved request
   * pathname (e.g. "/blog/a") to its prerendered HTML file (relative to the
   * build dir). The prod server serves a match directly and falls back to SSR
   * for params not in this map.
   */
  prerenderPaths?: Record<string, string>;
  /**
   * Optional ISR window in seconds (route `export const revalidate = <n>`).
   * When set, the prod server serves the (cached) HTML and re-renders in the
   * background once it is older than this many seconds.
   */
  revalidate?: number;
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
