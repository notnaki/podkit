// Minimal in-process tracing. A span carries a traceId (stable across a tree),
// a spanId, and a parentId (the enclosing span's spanId, if any). On end() we
// write one structured "span" event to the existing event sink — same JSONL
// store as logs/events — so traces are queryable with the same tooling.
//
// ponytail: in-process spans to the existing sink only — NO OTLP/remote export,
// no sampling, no span links/status codes. Current-span nesting uses node's
// native AsyncLocalStorage so withSpan() inside an async fn picks up its parent
// automatically; startSpan() also accepts an explicit parent for callers that
// can't rely on async context. Upgrade path: swap the sink write for an OTLP
// exporter (map traceId/spanId/parentId/startTime/durationMs onto the OTel data
// model) and add a sampler — the public API here stays the same.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Sink } from "./event.ts";

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentId: string | undefined;
  end(attrs?: Record<string, unknown>): void;
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, unknown>): Span;
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
}

// Holds the currently-active span so a child started within its async scope can
// find its parent without threading it through every call.
const current = new AsyncLocalStorage<Span>();

function newId(): string {
  // Hex without dashes — compact, and trivially mappable to OTel ids later.
  return randomUUID().replace(/-/g, "");
}

export function createTracer(sink: Sink): Tracer {
  function startSpan(
    name: string,
    attrs?: Record<string, unknown>,
    explicitParent?: Span,
  ): Span {
    const parent = explicitParent ?? current.getStore();
    const traceId = parent?.traceId ?? newId();
    const spanId = newId();
    const parentId = parent?.spanId;
    const startTime = Date.now();
    let ended = false;
    const startAttrs = attrs;

    const span: Span = {
      traceId,
      spanId,
      parentId,
      end(endAttrs?: Record<string, unknown>): void {
        // Guard against double-end: a span should produce exactly one event.
        if (ended) return;
        ended = true;
        const props = { ...startAttrs, ...endAttrs };
        sink.append({
          ts: Date.now(),
          kind: "span",
          name,
          traceId,
          spanId,
          ...(parentId !== undefined ? { parentId } : {}),
          startTime,
          durationMs: Date.now() - startTime,
          ...(Object.keys(props).length > 0 ? { props } : {}),
        });
      },
    };
    return span;
  }

  async function withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attrs?: Record<string, unknown>,
  ): Promise<T> {
    const span = startSpan(name, attrs);
    // Run fn inside this span's async context so any nested withSpan/startSpan
    // sees it as their parent. end() runs on both success and throw.
    return current.run(span, async () => {
      try {
        return await fn(span);
      } catch (err) {
        span.end({ error: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        // end() is idempotent, so the catch-path end() above wins and this is
        // a no-op on the error path; on the success path this is the end().
        span.end();
      }
    });
  }

  return { startSpan, withSpan };
}
