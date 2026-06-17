import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { htmlDocument } from "./document.ts";
import type { RouteModule } from "../loader/run.ts";

type PageComponent = (props: { data: unknown }) => ReactNode;
type LayoutComponent = (props: { data: unknown; children: ReactNode }) => ReactNode;

export async function renderPage(
  mod: RouteModule,
  data: unknown,
  clientEntry: string,
  layouts: RouteModule[] = [],
): Promise<string> {
  const Component = mod.default as PageComponent | undefined;
  let tree: ReactNode = Component ? createElement(Component, { data }) : null;
  // Wrap inside-out: layouts are outermost-first, so fold from the deepest in.
  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i].default as LayoutComponent | undefined;
    if (Layout) tree = createElement(Layout, { data, children: tree });
  }
  const appHtml = tree ? renderToString(tree) : "";
  return htmlDocument(appHtml, data, clientEntry);
}
