import type { LoaderContext } from "../types.ts";

export interface RouteModule {
  default?: unknown;
  loader?: (ctx: LoaderContext) => unknown | Promise<unknown>;
}

export async function runLoader(mod: RouteModule, ctx: LoaderContext): Promise<unknown> {
  if (typeof mod.loader !== "function") return {};
  return (await mod.loader(ctx)) ?? {};
}
