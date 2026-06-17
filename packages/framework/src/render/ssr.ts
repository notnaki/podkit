import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { htmlDocument } from "./document.ts";
import type { RouteModule } from "../loader/run.ts";

type PageComponent = (props: { data: unknown }) => ReactNode;
type LayoutComponent = (props: { data: unknown; children: ReactNode }) => ReactNode;

/** Build the page tree wrapped by its layouts, outermost-first. */
export function buildTree(
  mod: RouteModule,
  data: unknown,
  layouts: RouteModule[],
  layoutData: unknown[],
): ReactNode {
  const Component = mod.default as PageComponent | undefined;
  let tree: ReactNode = Component ? createElement(Component, { data }) : null;
  // Wrap inside-out: layouts are outermost-first, so fold from the deepest in.
  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i].default as LayoutComponent | undefined;
    if (Layout) tree = createElement(Layout, { data: layoutData[i], children: tree });
  }
  return tree;
}

export async function renderPage(
  mod: RouteModule,
  data: unknown,
  clientEntry: string,
  routeId: string,
  layouts: RouteModule[] = [],
  layoutData: unknown[] = [],
): Promise<string> {
  const tree = buildTree(mod, data, layouts, layoutData);
  const appHtml = tree ? renderToString(tree) : "";
  return htmlDocument(appHtml, data, clientEntry, routeId, layoutData);
}
