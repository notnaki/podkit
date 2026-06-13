import { describe, expect, it } from "vitest";
import type { Sink, TelemetryEvent } from "../src/event.ts";
import { aggregate, funnel, pageview, track } from "../src/analytics.ts";

function createFakeSink(): Sink {
  const events: TelemetryEvent[] = [];
  return {
    append(e: TelemetryEvent): void {
      events.push(e);
    },
    all(): TelemetryEvent[] {
      return events;
    },
  };
}

describe("analytics", () => {
  it("tracks events, aggregates, and computes funnels", () => {
    const sink = createFakeSink();

    track(sink, "signup");
    track(sink, "signup");
    pageview(sink, "/");

    expect(sink.all()).toHaveLength(3);

    expect(aggregate(sink.all())).toEqual({ signup: 2, pageview: 1 });

    expect(funnel(sink.all(), ["pageview", "signup"])).toEqual([
      { step: "pageview", count: 1 },
      { step: "signup", count: 2 },
    ]);
  });
});
