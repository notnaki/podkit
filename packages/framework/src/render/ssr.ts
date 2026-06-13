import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { htmlDocument } from "./document.ts";
import type { RouteModule } from "../loader/run.ts";

export async function renderPage(
  mod: RouteModule,
  data: unknown,
  clientEntry: string,
): Promise<string> {
  const Component = mod.default as ((props: { data: unknown }) => unknown) | undefined;
  const appHtml = Component ? renderToString(createElement(Component, { data }) as never) : "";
  return htmlDocument(appHtml, data, clientEntry);
}
