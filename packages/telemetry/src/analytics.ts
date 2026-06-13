import type { Sink, TelemetryEvent } from "./event.ts";

export function track(sink: Sink, name: string, props?: Record<string, unknown>): void {
  sink.append({ kind: "event", name, props, ts: Date.now() });
}

export function pageview(sink: Sink, path: string): void {
  track(sink, "pageview", { path });
}

export function aggregate(events: TelemetryEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    if (e.kind === "event" && e.name !== undefined) {
      counts[e.name] = (counts[e.name] ?? 0) + 1;
    }
  }
  return counts;
}

export function funnel(
  events: TelemetryEvent[],
  steps: string[],
): { step: string; count: number }[] {
  return steps.map((step) => ({
    step,
    count: events.filter((e) => e.kind === "event" && e.name === step).length,
  }));
}
