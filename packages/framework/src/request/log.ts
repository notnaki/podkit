import type { TelemetryEvent } from "@podkit/telemetry";

export function buildRequestEvent(entry: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  identity?: string;
}): TelemetryEvent {
  const { method, path, status, durationMs, requestId, identity } = entry;
  return {
    kind: "log",
    level: "info",
    message: `${method} ${path} -> ${status}`,
    route: path,
    requestId,
    identity,
    props: { method, status, durationMs },
    ts: Date.now(),
  };
}
