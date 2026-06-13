import type { LogLevel, Sink, TelemetryEvent } from "./event.ts";

export function createLogger(
  sink: Sink,
  base?: Partial<TelemetryEvent>,
): {
  debug: (message: string, fields?: Partial<TelemetryEvent>) => void;
  info: (message: string, fields?: Partial<TelemetryEvent>) => void;
  warn: (message: string, fields?: Partial<TelemetryEvent>) => void;
  error: (message: string, fields?: Partial<TelemetryEvent>) => void;
} {
  function log(level: LogLevel, message: string, fields?: Partial<TelemetryEvent>): void {
    sink.append({
      kind: "log",
      level,
      message,
      ts: Date.now(),
      ...base,
      ...fields,
    });
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}
