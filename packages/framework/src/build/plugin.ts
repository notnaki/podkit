import MagicString from "magic-string";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { buildRouteTable, findLayouts } from "../routing/discover.ts";

// Virtual module ids the client entry imports. The route table can't live in the
// framework package (it's app-specific), so a plugin generates it per app.
const VIRTUAL_ROUTES = "virtual:podkit-routes";
const RESOLVED_ROUTES = "\0" + VIRTUAL_ROUTES;

/**
 * The client hydration entry. Picks the route module the server rendered
 * (`window.__PODKIT_ROUTE__`), rebuilds the same layout-wrapped tree with the
 * embedded loader data, and hydrates it. Written to disk by the dev/build step
 * and used as the client build input; it pulls the per-app route table from the
 * `virtual:podkit-routes` module this plugin generates.
 */
export const CLIENT_ENTRY_SOURCE = `import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { routes, layoutComponents } from "${VIRTUAL_ROUTES}";

const w = window as unknown as { __PODKIT_ROUTE__?: string; __PODKIT_DATA__?: unknown; __PODKIT_LAYOUT_DATA__?: unknown[] };
const entry = w.__PODKIT_ROUTE__ ? routes[w.__PODKIT_ROUTE__] : undefined;
const root = document.getElementById("root");
if (entry && root) {
  const data = w.__PODKIT_DATA__;
  const layoutData = w.__PODKIT_LAYOUT_DATA__ ?? [];
  let tree = createElement(entry.component, { data });
  for (let i = entry.layouts.length - 1; i >= 0; i--) {
    tree = createElement(layoutComponents[entry.layouts[i]], { data: layoutData[i], children: tree });
  }
  hydrateRoot(root, tree);
}
`;

function listFiles(dir: string, root = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
}

const isLayout = (f: string) => /(^|\/)_layout\.(tsx|jsx)$/.test(f);

/**
 * Generate the `virtual:podkit-routes` module: default-imports every route +
 * layout component and maps them by source file (the same id the server embeds
 * as `__PODKIT_ROUTE__`), with each route's layout chain.
 */
export function generateRoutesModule(appRoot: string): string {
  const routesDir = join(appRoot, "app", "routes");
  const all = listFiles(routesDir);
  const table = buildRouteTable(all);
  const layoutFiles = all.filter(isLayout);

  const imports: string[] = [];
  const routeEntries: string[] = [];
  let n = 0;
  for (const r of table) {
    const v = `C${n++}`;
    imports.push(`import ${v} from ${JSON.stringify(join(routesDir, r.file))};`);
    routeEntries.push(
      `${JSON.stringify(r.file)}: { component: ${v}, layouts: ${JSON.stringify(findLayouts(all, r.file))} }`,
    );
  }
  const layoutEntries: string[] = [];
  let m = 0;
  for (const lf of layoutFiles) {
    const v = `L${m++}`;
    imports.push(`import ${v} from ${JSON.stringify(join(routesDir, lf))};`);
    layoutEntries.push(`${JSON.stringify(lf)}: ${v}`);
  }

  return (
    imports.join("\n") +
    `\nexport const routes = {${routeEntries.join(", ")}};\n` +
    `export const layoutComponents = {${layoutEntries.join(", ")}};\n`
  );
}

interface AstNode {
  type: string;
  start: number;
  end: number;
  [k: string]: unknown;
}

// loader/action are the server-only route exports; everything else is treated as
// client-safe. ponytail: only the declaration form (`export const loader = …` /
// `export function loader …`) is stripped — the rare `export { loader }`
// specifier form isn't; switch to specifier exports and this would need a case.
const SERVER_EXPORTS = new Set(["loader", "action"]);

/**
 * Remove `loader`/`action` exports from a route module's client build and drop
 * the imports that only they used, so server-only code (node:*, @podkit/db, pg,
 * drizzle) never reaches the browser bundle. Parses the (already-JS) source via
 * the plugin's acorn parser; returns null when there's nothing to strip.
 */
export function stripServerCode(code: string, parse: (c: string) => unknown): string | null {
  const ast = parse(code) as { body: AstNode[] };
  const removed: Array<[number, number]> = [];
  const importDecls: AstNode[] = [];

  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      importDecls.push(node);
      continue;
    }
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const decl = node.declaration as AstNode;
      let names: string[] = [];
      if (decl.type === "VariableDeclaration") {
        names = (decl.declarations as AstNode[])
          .map((d) => (d.id as AstNode)?.name as string)
          .filter(Boolean);
      } else if (decl.type === "FunctionDeclaration" && decl.id) {
        names = [(decl.id as AstNode).name as string];
      }
      if (names.length > 0 && names.every((nm) => SERVER_EXPORTS.has(nm))) {
        removed.push([node.start, node.end]);
      }
    }
  }

  if (removed.length === 0) return null;

  // Identifiers still referenced outside import declarations and removed ranges.
  const used = new Set<string>();
  const inRemoved = (n: AstNode) => removed.some(([s, e]) => n.start >= s && n.end <= e);
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const c of value) walk(c);
      return;
    }
    const n = value as AstNode;
    if (typeof n.type !== "string") return;
    if (n.type === "ImportDeclaration") return; // import locals aren't "uses"
    if (inRemoved(n)) return;
    if ((n.type === "Identifier" || n.type === "JSXIdentifier") && typeof n.name === "string") {
      used.add(n.name as string);
    }
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end") continue;
      walk((n as Record<string, unknown>)[key]);
    }
  };
  walk(ast.body);

  const ms = new MagicString(code);
  for (const [s, e] of removed) ms.remove(s, e);
  for (const imp of importDecls) {
    const specs = (imp.specifiers as AstNode[]) ?? [];
    if (specs.length === 0) continue; // bare `import "x"`: keep (side effects)
    const anyUsed = specs.some((sp) => used.has((sp.local as AstNode)?.name as string));
    if (!anyUsed) ms.remove(imp.start, imp.end);
  }
  return ms.toString();
}

/**
 * The podkit Vite plugins: (1) serves the virtual route table, (2) strips
 * server-only route code from client builds. Registered by both the dev server
 * and the production client build so behaviour is identical.
 */
export function podkitPlugins(appRoot: string): unknown[] {
  const routesDir = join(appRoot, "app", "routes").split("\\").join("/");

  const virtuals = {
    name: "podkit:virtuals",
    resolveId(id: string) {
      if (id === VIRTUAL_ROUTES) return RESOLVED_ROUTES;
      return null;
    },
    load(id: string) {
      if (id === RESOLVED_ROUTES) return generateRoutesModule(appRoot);
      return null;
    },
  };

  const strip = {
    name: "podkit:strip-server",
    enforce: "post" as const,
    transform(this: { parse: (c: string) => unknown }, code: string, id: string, opts?: { ssr?: boolean }) {
      if (opts?.ssr) return null;
      const clean = id.split("?")[0].split("\\").join("/");
      if (!clean.startsWith(routesDir) || !/\.(tsx|jsx)$/.test(clean)) return null;
      const out = stripServerCode(code, (c) => this.parse(c));
      return out === null ? null : { code: out, map: null };
    },
  };

  return [virtuals, strip];
}
