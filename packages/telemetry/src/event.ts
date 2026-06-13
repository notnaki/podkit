import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface TelemetryEvent {
  ts: number;
  kind: "log" | "event";
  level?: LogLevel;
  message?: string;
  name?: string;
  props?: Record<string, unknown>;
  route?: string;
  requestId?: string;
  deployVersion?: string;
  identity?: string;
}

export interface Sink {
  append(e: TelemetryEvent): void;
  all(): TelemetryEvent[];
}

export function createSink(opts: { file: string }): Sink {
  const { file } = opts;
  return {
    append(e: TelemetryEvent): void {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(e) + "\n");
    },
    all(): TelemetryEvent[] {
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TelemetryEvent);
    },
  };
}

export interface EventFilter {
  kind?: "log" | "event";
  level?: LogLevel;
  route?: string;
  name?: string;
  since?: number;
}

export function query(events: TelemetryEvent[], filter: EventFilter): TelemetryEvent[] {
  return events.filter((e) => {
    if (filter.kind !== undefined && e.kind !== filter.kind) return false;
    if (filter.level !== undefined && e.level !== filter.level) return false;
    if (filter.route !== undefined && e.route !== filter.route) return false;
    if (filter.name !== undefined && e.name !== filter.name) return false;
    if (filter.since !== undefined && !(e.ts >= filter.since)) return false;
    return true;
  });
}
