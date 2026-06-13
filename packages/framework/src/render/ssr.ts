import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { htmlDocument } from "./document.ts";
import type { RouteModule } from "../loader/run.ts";

type PageComponent = (props: { data: unknown }) => ReactNode;

export async function renderPage(
  mod: RouteModule,
  data: unknown,
  clientEntry: string,
): Promise<string> {
  const Component = mod.default as PageComponent | undefined;
  const appHtml = Component ? renderToString(createElement(Component, { data })) : "";
  return htmlDocument(appHtml, data, clientEntry);
}
