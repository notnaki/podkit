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
 * close + hydration data + module script) once ALL Suspense content has flushed.
 *
 * Suspense correctness: we start streaming at `onShellReady`, so the shell (with
 * any <Suspense> fallbacks) flushes immediately and React appends the resolved
 * boundary HTML + its inline swap scripts as each promise settles. The tail
 * carries the hydration data, so it MUST land after every boundary. React's
 * pipe() would `end()` its destination as soon as it is done, leaving no hook to
 * append the tail — so we pipe React into a PassThrough we own and write the
 * tail on the bridge's `end` (fired only after React has flushed the shell AND
 * every resolved Suspense boundary), guaranteeing the data tail comes last.
 *
 * ponytail: ceiling is whole-document streaming with the data tail emitted last
 * — no selective hydration tuning, no per-boundary `bootstrapScripts`, no
 * `onError` -> degraded shell, and bridge→res chunk forwarding is a plain `data`
 * listener (res is duck-typed in tests, so no pipe() backpressure on that leg;
 * React→bridge backpressure is preserved). Upgrade: switch to a Web
 * ReadableStream + `bootstrapScriptContent` for edge runtimes.
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
  // Bridge React's output to res while keeping res open for our tail: forward
  // each chunk to res and, on the bridge's `end` (after React flushed the shell
  // AND every resolved Suspense boundary), write the tail + end res ourselves.
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
