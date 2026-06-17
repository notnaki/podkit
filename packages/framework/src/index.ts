export { buildRouteTable } from "./routing/discover.ts";
export { matchRoute } from "./routing/match.ts";
export { runLoader, runAction } from "./loader/run.ts";
export { renderPage, renderPageToStream } from "./render/ssr.ts";
export { createDevServer } from "./server/dev-server.ts";
export { createProdServer } from "./server/prod-server.ts";
export { buildApp } from "./build/app.ts";
export { readManifest, writeManifest } from "./build/manifest.ts";
// link.ts uses createElement (no JSX) on purpose, so it stays a .ts file the
// node-run CLI can type-strip — re-exporting a .tsx here would break `podkit dev`.
export { Link } from "./client/link.ts";
export type { LinkProps } from "./client/link.ts";
export type { BuildAppOptions, BuildAppResult } from "./build/app.ts";
export type { BuildManifest, BuildManifestRoute } from "./build/manifest.ts";
export type { ProdServerOptions } from "./server/prod-server.ts";
export type { Route, RouteKind, LoaderContext, ActionContext, ActionResult, PageProps, LoaderData } from "./types.ts";
export type { CookieDirective } from "./request/cookie.ts";
