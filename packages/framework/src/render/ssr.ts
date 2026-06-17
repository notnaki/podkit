import { createElement, type ReactNode } from "react";
import { renderToString, renderToPipeableStream } from "react-dom/server";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { htmlDocument, documentHead, documentTail } from "./document.ts";
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

/**
 * Stream the page HTML to a Node ServerResponse. Writes the document head,
 * pipes the React shell (renderToPipeableStream), then writes the tail (root
 * close + hydration data + module script) once the shell is done.
 *
 * ponytail: basic renderToPipeableStream with onShellReady — no Suspense
 * boundary tuning, no selective hydration, no onAllReady backpressure handling
 * beyond what pipe() gives us. Upgrade: stream with Suspense + emit the tail
 * from onAllReady (or use onShellError -> 500) if/when routes adopt streaming
 * data; switch to a Web ReadableStream for edge runtimes.
 */
export function renderPageToStream(
  res: ServerResponse,
  mod: RouteModule,
  data: unknown,
  clientEntry: string,
  routeId: string,
  layouts: RouteModule[] = [],
  layoutData: unknown[] = [],
): void {
  const tree = buildTree(mod, data, layouts, layoutData);
  if (!tree) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html");
    res.end(htmlDocument("", data, clientEntry, routeId, layoutData));
    return;
  }
  const tail = documentTail(data, clientEntry, routeId, layoutData);
  // React's pipe() ends its destination when the shell completes, leaving no
  // hook to append our tail. Pipe into a PassThrough we own: forward its chunks
  // to res, and on its `end` write the tail + end res ourselves.
  const bridge = new PassThrough();
  bridge.on("data", (chunk) => res.write(chunk));
  bridge.on("end", () => {
    res.end(tail);
  });
  const { pipe } = renderToPipeableStream(tree, {
    onShellReady() {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html");
      res.write(documentHead(""));
      pipe(bridge);
    },
    onShellError(err) {
      // Shell render failed before any bytes went out: emit a 500.
      res.statusCode = 500;
      res.setHeader("content-type", "text/html");
      res.end(err instanceof Error ? err.stack : String(err));
    },
  });
}
