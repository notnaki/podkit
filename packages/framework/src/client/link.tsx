import { createElement, type MouseEvent, type ReactNode } from "react";

export interface LinkProps {
  href: string;
  children?: ReactNode;
  // Pass-through for the rendered <a> (className, target, rel, onClick, …).
  [key: string]: unknown;
}

/**
 * Client-side navigation link. Renders a plain <a href> so it works without JS
 * (and for crawlers / right-click "open in new tab"). On a plain left-click it
 * intercepts the navigation, pushes history, and lets the client router swap the
 * tree in place — see `navigate()` in CLIENT_ENTRY_SOURCE.
 *
 * It is a normal client component (NOT a route module), so the build's
 * server-code stripping never touches it.
 */
export function Link({ href, children, onClick, ...rest }: LinkProps): ReactNode {
  function handleClick(e: MouseEvent<HTMLAnchorElement>): void {
    if (typeof onClick === "function") {
      (onClick as (ev: MouseEvent<HTMLAnchorElement>) => void)(e);
    }
    // Honor a caller's preventDefault, and only hijack plain left-clicks.
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const target = (rest as { target?: string }).target;
    if (target && target !== "_self") return; // _blank etc.: let the browser do it.

    // Resolve relative to the current document; bail on cross-origin.
    const dest = new URL(href, window.location.href);
    if (dest.origin !== window.location.origin) return;

    e.preventDefault();
    const nav = (window as unknown as { __podkitNavigate?: (u: string) => void }).__podkitNavigate;
    if (nav) {
      nav(dest.pathname + dest.search + dest.hash);
    } else {
      // Router not installed (e.g. before hydration): fall back to a real nav.
      window.location.assign(href);
    }
  }

  return createElement("a", { ...rest, href, onClick: handleClick }, children);
}
