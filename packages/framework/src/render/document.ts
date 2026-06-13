export function htmlDocument(appHtml: string, data: unknown, clientEntry: string): string {
  const serialized = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body><div id="root">${appHtml}</div><script>window.__PODKIT_DATA__ = ${serialized}</script><script type="module" src="${clientEntry}"></script></body></html>`;
}
