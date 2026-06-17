export function htmlDocument(
  appHtml: string,
  data: unknown,
  clientEntry: string,
  routeId: string,
  layoutData: unknown[] = [],
): string {
  return documentHead(appHtml) + documentTail(data, clientEntry, routeId, layoutData);
}

/** Everything up to and including the open of the hydration root. */
export function documentHead(appHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body><div id="root">${appHtml}`;
}

/** Closes the root and emits the hydration data + client module scripts. */
export function documentTail(
  data: unknown,
  clientEntry: string,
  routeId: string,
  layoutData: unknown[] = [],
): string {
  const serialized = JSON.stringify(data).replace(/</g, "\\u003c");
  const route = JSON.stringify(routeId).replace(/</g, "\\u003c");
  const layouts = JSON.stringify(layoutData).replace(/</g, "\\u003c");
  return `</div><script>window.__PODKIT_DATA__ = ${serialized};window.__PODKIT_ROUTE__ = ${route};window.__PODKIT_LAYOUT_DATA__ = ${layouts}</script><script type="module" src="${clientEntry}"></script></body></html>`;
}
