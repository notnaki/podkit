import type { ActionContext, ActionResult, LoaderContext } from "../types.ts";

export interface RouteModule {
  default?: unknown;
  loader?: (ctx: LoaderContext) => unknown | Promise<unknown>;
  action?: (ctx: ActionContext) => ActionResult | Promise<ActionResult>;
}

export async function runLoader(mod: RouteModule, ctx: LoaderContext): Promise<unknown> {
  if (typeof mod.loader !== "function") return {};
  return (await mod.loader(ctx)) ?? {};
}

export async function runAction(mod: RouteModule, ctx: ActionContext): Promise<ActionResult> {
  if (typeof mod.action !== "function") {
    throw new Error("route has no action");
  }
  return await mod.action(ctx);
}
