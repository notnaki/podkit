import type { Route } from "../types.ts";

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

const rank = { static: 0, dynamic: 1, catchall: 2 } as const;

export function matchRoute(table: Route[], pathname: string): RouteMatch | null {
  const reqSegs = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const ordered = [...table].sort((a, b) => rank[a.kind] - rank[b.kind]);

  for (const route of ordered) {
    const patSegs = route.pattern.split("/").filter(Boolean);
    const params: Record<string, string> = {};

    if (route.kind === "catchall") {
      const fixed = patSegs.slice(0, -1);
      if (reqSegs.length < fixed.length) continue;
      let ok = true;
      for (let i = 0; i < fixed.length; i++) {
        if (fixed[i] !== reqSegs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      const name = patSegs[patSegs.length - 1].slice(1); // strip leading "*"
      params[name] = reqSegs.slice(fixed.length).join("/");
      return { route, params };
    }

    if (patSegs.length !== reqSegs.length) continue;
    let ok = true;
    for (let i = 0; i < patSegs.length; i++) {
      const p = patSegs[i];
      if (p.startsWith(":")) params[p.slice(1)] = reqSegs[i];
      else if (p !== reqSegs[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}
