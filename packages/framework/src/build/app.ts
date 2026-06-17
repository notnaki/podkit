import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { buildRouteTable, findLayouts } from "../routing/discover.ts";
import { podkitPlugins, CLIENT_ENTRY_SOURCE } from "./plugin.ts";
import { writeManifest, type BuildManifest, type BuildManifestRoute } from "./manifest.ts";

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

/**
 * Keep every bare (node_modules / node:) import external to the SSR bundle, so
 * only the app's own source (relative/absolute imports) is bundled. This is
 * standard SSR behavior: server dependencies — react, @podkit/*, and crucially
 * native/CJS/wasm packages like `pg`, `pglite`, and `drizzle-orm` that a route's
 * loader/action pulls in via `@podkit/db`/`@podkit/auth` — are resolved from
 * node_modules at runtime instead of being bundled (bundling them would break).
 */
function isBareImport(id: string): boolean {
  return !id.startsWith(".") && !id.startsWith("\0") && !isAbsolute(id);
}

/**
 * Map a source route file to a filesystem-safe SSR output slug. Rollup/Vite
 * rewrite special characters (e.g. `[`/`]`) in entry names, which would make the
 * emitted file name diverge from what we record in the manifest. By replacing
 * those characters ourselves up front, the input key, emitted file name, and
 * manifest entry stay in lockstep.
 */
function ssrSlug(file: string): string {
  return file.replace(/\.(tsx|jsx)$/, "").replace(/[\[\]]/g, "_").replace(/\.\.\./g, "___");
}

export interface BuildAppOptions {
  /** Skip building (used in tests to assert pure planning). Currently unused. */
  skip?: boolean;
}

export interface BuildAppResult {
  outDir: string;
  routeCount: number;
  clientEntry: string;
  manifest: BuildManifest;
}

/**
 * Produce a production build of a podkit app.
 *
 * Three steps:
 *  1. Vite client build: bundles the framework-owned hydration entry (which
 *     pulls the per-app route table from virtual:podkit-routes) into hashed
 *     assets under <outDir>/client with a manifest.json (drives the hashed
 *     <script> path). The podkit plugin strips server-only route code here.
 *  2. Vite SSR build: pre-compiles every discovered route module into an ESM
 *     file under <outDir>/server/routes/<slug>-SSR.js, with react/react-dom
 *     kept external. The prod server dynamically imports these directly — no
 *     ssrLoadModule, no Vite at runtime.
 *  3. Writes <outDir>/build-manifest.json describing routes + the hashed client
 *     entry so the prod server can match routes and emit the correct script tag.
 */
export async function buildApp(
  appRoot: string,
  outDir: string,
  _opts: BuildAppOptions = {},
): Promise<BuildAppResult> {
  const routesDir = join(appRoot, "app", "routes");
  const allFiles = listFiles(routesDir).map((f) => f.split("\\").join("/"));
  const table = buildRouteTable(allFiles);
  const layoutFiles = allFiles.filter((f) => /(^|\/)_layout\.(tsx|jsx)$/.test(f));

  const clientOutDir = join(outDir, "client");
  const serverOutDir = join(outDir, "server");

  // The framework owns the client entry (hydration bootstrap). Write it under
  // the build dir and feed it to Vite as the client input; it pulls the per-app
  // route table from the plugin's virtual:podkit-routes module.
  mkdirSync(outDir, { recursive: true });
  const clientEntrySrc = join(outDir, "client-entry.tsx");
  writeFileSync(clientEntrySrc, CLIENT_ENTRY_SOURCE);

  // (1) Client build — framework hydration entry, hashed + manifest. The podkit
  // plugins serve the virtual route table and strip server-only route code.
  await viteBuild({
    root: appRoot,
    logLevel: "warn",
    plugins: [react(), ...(podkitPlugins(appRoot) as never[])],
    build: {
      outDir: clientOutDir,
      emptyOutDir: true,
      manifest: true,
      ssr: false,
      rollupOptions: {
        input: clientEntrySrc,
        output: {
          entryFileNames: "entry-[hash].js",
          chunkFileNames: "chunk-[hash].js",
          assetFileNames: "asset-[hash][extname]",
        },
      },
    },
  });

  // (2) SSR build — one pre-compiled module per route file. react/react-dom
  // stay external so the runtime resolves the real (singleton) copies.
  const routeInputs: Record<string, string> = {};
  for (const route of table) {
    routeInputs[`routes/${ssrSlug(route.file)}-SSR`] = join(routesDir, route.file);
  }
  // Layouts are SSR-compiled too so the prod server can wrap pages with them.
  for (const lf of layoutFiles) {
    routeInputs[`routes/${ssrSlug(lf)}-SSR`] = join(routesDir, lf);
  }

  if (Object.keys(routeInputs).length > 0) {
    await viteBuild({
      root: appRoot,
      logLevel: "warn",
      plugins: [react()],
      build: {
        outDir: serverOutDir,
        emptyOutDir: true,
        ssr: true,
        manifest: false,
        rollupOptions: {
          input: routeInputs,
          external: (id: string) => isBareImport(id),
          output: {
            format: "es",
            entryFileNames: "[name].js",
            chunkFileNames: "chunks/[name]-[hash].js",
          },
        },
      },
    });
  }

  // (4) Resolve the hashed client entry from Vite's client manifest.
  const clientManifestPath = join(clientOutDir, ".vite", "manifest.json");
  const clientManifest = JSON.parse(readFileSync(clientManifestPath, "utf8")) as Record<
    string,
    { file: string; isEntry?: boolean }
  >;
  let entryFile: string | undefined;
  for (const value of Object.values(clientManifest)) {
    if (value.isEntry) {
      entryFile = value.file;
      break;
    }
  }
  if (!entryFile) {
    throw new Error("buildApp: could not find client entry in Vite manifest");
  }
  const clientEntry = `/client/${entryFile}`;

  // (5) Write the build manifest used by the prod server.
  const routes: BuildManifestRoute[] = table.map((route) => ({
    pattern: route.pattern,
    kind: route.kind,
    file: route.file,
    params: route.params,
    serverFile: `routes/${ssrSlug(route.file)}-SSR.js`,
    layouts: findLayouts(allFiles, route.file).map((lf) => `routes/${ssrSlug(lf)}-SSR.js`),
  }));

  const manifest: BuildManifest = {
    routes,
    clientDir: "client",
    serverDir: "server",
    clientEntry,
  };

  writeManifest(join(outDir, "build-manifest.json"), manifest);

  return { outDir, routeCount: table.length, clientEntry, manifest };
}
