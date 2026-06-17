// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Link } from "../src/client/link.tsx";

describe("Link — markup", () => {
  it("renders a plain <a href> with passthrough props (works without JS)", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { href: "/about", className: "nav" }, "About"),
    );
    expect(html).toBe('<a class="nav" href="/about">About</a>');
  });
});

// Exercise the click interception against jsdom. We call the React onClick
// handler directly with a synthetic-event-like object so we don't need a full
// DOM render — the handler only reads button/modifier flags and href.
describe("Link — click interception", () => {
  let navigated: string[];

  beforeEach(() => {
    navigated = [];
    (window as unknown as { __podkitNavigate?: (p: string) => void }).__podkitNavigate = (p) =>
      navigated.push(p);
  });

  afterEach(() => {
    delete (window as unknown as { __podkitNavigate?: unknown }).__podkitNavigate;
    vi.restoreAllMocks();
  });

  function clickEvent(over: Partial<Record<string, unknown>> = {}) {
    let prevented = false;
    return {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
      ...over,
    };
  }

  function handlerFor(props: Record<string, unknown>) {
    const el = Link(props as never) as { props: { onClick: (e: unknown) => void } };
    return el.props.onClick;
  }

  it("intercepts a plain left-click and calls __podkitNavigate", () => {
    const e = clickEvent();
    handlerFor({ href: "/about" })(e);
    expect(e.defaultPrevented).toBe(true);
    expect(navigated).toEqual(["/about"]);
  });

  it("ignores modifier / non-left clicks (lets the browser handle them)", () => {
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const e = clickEvent(over);
      handlerFor({ href: "/about" })(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(navigated).toEqual([]);
  });

  it("ignores target=_blank", () => {
    const e = clickEvent();
    handlerFor({ href: "/about", target: "_blank" })(e);
    expect(e.defaultPrevented).toBe(false);
    expect(navigated).toEqual([]);
  });

  it("does not intercept cross-origin hrefs", () => {
    const e = clickEvent();
    handlerFor({ href: "https://example.com/x" })(e);
    expect(e.defaultPrevented).toBe(false);
    expect(navigated).toEqual([]);
  });

  it("passes pathname+search+hash to the router", () => {
    const e = clickEvent();
    handlerFor({ href: "/blog/hello?a=1#top" })(e);
    expect(navigated).toEqual(["/blog/hello?a=1#top"]);
  });

  it("still fires a caller-provided onClick", () => {
    const spy = vi.fn();
    const e = clickEvent();
    handlerFor({ href: "/about", onClick: spy })(e);
    expect(spy).toHaveBeenCalledOnce();
    expect(navigated).toEqual(["/about"]);
  });
});

describe("Link — prefetch on hover/focus", () => {
  let prefetched: string[];

  beforeEach(() => {
    prefetched = [];
    (window as unknown as { __podkitPrefetch?: (p: string) => void }).__podkitPrefetch = (p) =>
      prefetched.push(p);
  });

  afterEach(() => {
    delete (window as unknown as { __podkitPrefetch?: unknown }).__podkitPrefetch;
    vi.restoreAllMocks();
  });

  function enterHandlerFor(props: Record<string, unknown>) {
    const el = Link(props as never) as { props: { onMouseEnter: (e: unknown) => void } };
    return el.props.onMouseEnter;
  }

  it("prefetches a same-origin path on mouse enter", () => {
    enterHandlerFor({ href: "/blog/hello?a=1" })({});
    expect(prefetched).toEqual(["/blog/hello?a=1"]);
  });

  it("does not prefetch cross-origin links", () => {
    enterHandlerFor({ href: "https://example.com/x" })({});
    expect(prefetched).toEqual([]);
  });

  it("still fires a caller-provided onMouseEnter", () => {
    const spy = vi.fn();
    enterHandlerFor({ href: "/about", onMouseEnter: spy })({});
    expect(spy).toHaveBeenCalledOnce();
    expect(prefetched).toEqual(["/about"]);
  });
});
