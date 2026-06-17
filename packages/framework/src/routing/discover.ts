import type { Route } from "../types.ts";

export function buildRouteTable(files: string[]): Route[] {
  const routes: Route[] = [];
  for (const file of files) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    const base = file.replace(/\.(tsx|jsx)$/, "");
    const segments = base.split("/");
    // Skip private (`_layout`) and hidden/dotfile (`.foo`, macOS AppleDouble
    // `._foo`) segments — they are never routes. Without the dotfile guard a
    // "._index.tsx" sidecar (from a macOS-made tarball) becomes a route and
    // breaks the build when esbuild tries to compile its binary contents.
    if (segments.some((s) => s.startsWith("_") || s.startsWith("."))) continue;

    const params: string[] = [];
    let kind: Route["kind"] = "static";
    const out: string[] = [];

    for (const seg of segments) {
      if (seg === "index") continue;
      const catchall = seg.match(/^\[\.\.\.(.+)\]$/);
      const dynamic = seg.match(/^\[(.+)\]$/);
      if (catchall) {
        params.push(catchall[1]);
        kind = "catchall";
        out.push(`*${catchall[1]}`);
      } else if (dynamic) {
        params.push(dynamic[1]);
        if (kind !== "catchall") kind = "dynamic";
        out.push(`:${dynamic[1]}`);
      } else {
        out.push(seg);
      }
    }

    const pattern = "/" + out.join("/");
    routes.push({ pattern: pattern === "/" ? "/" : pattern.replace(/\/$/, ""), kind, file, params });
  }
  return routes;
}

/**
 * The `_layout.tsx` chain that wraps a route, outermost first.
 *
 * `app/routes/_layout.tsx` wraps every route; `app/routes/<dir>/_layout.tsx`
 * wraps routes under `<dir>`. For `dash/settings/index.tsx` the chain is
 * [`_layout.tsx`, `dash/_layout.tsx`, `dash/settings/_layout.tsx`] — whichever
 * of those exist. Each layout receives `{ children, data }` where `data` is its
 * OWN loader result (run with the same context as the page), or `{}` if it has
 * no loader.
 */
export function findLayouts(files: string[], routeFile: string): string[] {
  const have = new Set(files);
  const slash = routeFile.lastIndexOf("/");
  const segs = slash < 0 ? [] : routeFile.slice(0, slash).split("/");
  const out: string[] = [];
  for (let i = 0; i <= segs.length; i++) {
    const prefix = segs.slice(0, i).join("/");
    for (const ext of ["tsx", "jsx"]) {
      const cand = (prefix ? prefix + "/" : "") + "_layout." + ext;
      if (have.has(cand)) {
        out.push(cand);
        break;
      }
    }
  }
  return out;
}
