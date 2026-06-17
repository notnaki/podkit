import { describe, expect, it } from "vitest";
import type { Sink, TelemetryEvent } from "../src/event.ts";
import { createTracer } from "../src/trace.ts";

function fakeSink(): { sink: Sink; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return {
    events,
    sink: {
      append(e) {
        events.push(e);
      },
      all() {
        return events;
      },
    },
  };
}

describe("createTracer", () => {
  it("withSpan emits a span event with a duration on success", async () => {
    const { sink, events } = fakeSink();
    const tracer = createTracer(sink);

    const result = await tracer.withSpan("work", async () => {
      // small delay so durationMs is observably >= 0
      await new Promise((r) => setTimeout(r, 2));
      return 42;
    });

    expect(result).toBe(42);
    expect(events).toHaveLength(1);
    const span = events[0]!;
    expect(span.kind).toBe("span");
    expect(span.name).toBe("work");
    expect(typeof span.traceId).toBe("string");
    expect(typeof span.spanId).toBe("string");
    expect(span.parentId).toBeUndefined();
    expect(typeof span.durationMs).toBe("number");
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof span.startTime).toBe("number");
  });

  it("nested withSpan links child to parent with shared traceId", async () => {
    const { sink, events } = fakeSink();
    const tracer = createTracer(sink);

    await tracer.withSpan("parent", async () => {
      await tracer.withSpan("child", async () => undefined);
    });

    // child ends first (inner), then parent.
    expect(events).toHaveLength(2);
    const child = events.find((e) => e.name === "child")!;
    const parent = events.find((e) => e.name === "parent")!;

    expect(parent.parentId).toBeUndefined();
    expect(child.parentId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it("ends the span and records the error message when fn throws", async () => {
    const { sink, events } = fakeSink();
    const tracer = createTracer(sink);

    await expect(
      tracer.withSpan("boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");

    expect(events).toHaveLength(1);
    const span = events[0]!;
    expect(span.kind).toBe("span");
    expect(span.name).toBe("boom");
    expect((span.props as { error?: string }).error).toBe("nope");
    expect(typeof span.durationMs).toBe("number");
  });

  it("startSpan honors an explicit parent via async context", async () => {
    const { sink, events } = fakeSink();
    const tracer = createTracer(sink);

    const root = tracer.startSpan("root", { a: 1 });
    root.end({ b: 2 });

    const span = events[0]!;
    expect(span.parentId).toBeUndefined();
    expect(span.props).toEqual({ a: 1, b: 2 });
  });
});
