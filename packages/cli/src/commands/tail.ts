// Cursor + de-dup logic for `podkit logs --follow`. Pure and source-agnostic so
// it can be unit-tested with a fake source returning growing batches.
//
// The follow loop polls a source with a moving `since` cursor (the cloud logs
// endpoint already supports `?since`, which is inclusive: it returns events with
// ts >= since). Because `since` is inclusive, the line(s) exactly at the cursor
// timestamp come back on the NEXT poll too — so we must de-dupe. We do that by
// remembering which event identities we've already emitted at the current
// cursor timestamp, and dropping anything we've seen before advancing.
//
// ponytail: client-side polling tail, NOT server push — no SSE/websocket. The
// source is polled every `intervalMs`. Upgrade path: replace pollSource with a
// streaming subscription (SSE/ws) and keep `accept()`'s de-dup as a safety net
// for reconnects.

import type { TelemetryEvent } from "@podkit/telemetry";

// A stable-enough identity for a single event. The sink has no id field, so we
// derive one from the fields that distinguish two log lines. Two events that
// collide on ALL of these at the same ts are genuinely indistinguishable and
// collapsing them is acceptable.
export function eventKey(e: TelemetryEvent): string {
  return JSON.stringify([
    e.ts,
    e.kind,
    e.level ?? "",
    e.message ?? "",
    e.name ?? "",
    e.route ?? "",
    e.requestId ?? "",
    e.spanId ?? "",
  ]);
}

export interface TailState {
  // Lower bound to request on the next poll (pass as `?since`). undefined means
  // "from the beginning" on the first poll.
  since: number | undefined;
  // Keys already emitted at exactly `since` ms, so the inclusive boundary line
  // is not re-printed next poll. Cleared whenever the cursor advances.
  seenAtCursor: Set<string>;
}

export function initTailState(since?: number): TailState {
  return { since, seenAtCursor: new Set() };
}

// Given a freshly-fetched batch, return the events that are genuinely new
// (in arrival order) and advance `state` in place. Batches may overlap the
// previous poll at the boundary timestamp; out-of-order or older events are
// dropped defensively.
export function accept(state: TailState, batch: TelemetryEvent[]): TelemetryEvent[] {
  const fresh: TelemetryEvent[] = [];

  for (const e of batch) {
    if (typeof e.ts !== "number") continue; // skip malformed
    if (state.since !== undefined && e.ts < state.since) continue; // older than cursor

    const key = eventKey(e);
    if (state.since !== undefined && e.ts === state.since && state.seenAtCursor.has(key)) {
      continue; // already emitted at the boundary
    }
    fresh.push(e);
  }

  // Advance the cursor to the max ts seen across emitted + boundary events.
  for (const e of fresh) {
    if (typeof e.ts !== "number") continue;
    if (state.since === undefined || e.ts > state.since) {
      state.since = e.ts;
      state.seenAtCursor = new Set();
    }
    if (e.ts === state.since) {
      state.seenAtCursor.add(eventKey(e));
    }
  }

  return fresh;
}

// Line-based tail, for raw text log blobs (e.g. `docker logs` output from the
// cloud endpoint). `docker logs --since` is inclusive at second granularity, so
// successive polls re-return the boundary lines; we de-dupe against the lines
// emitted on the previous poll. We keep ALL previously-seen lines bounded to a
// recent window so identical lines far apart are still printed.
export interface LineTailState {
  // Lines already emitted, in order, capped to `window`. New polls are diffed
  // against this set to drop repeats from the inclusive `--since` overlap.
  recent: string[];
  recentSet: Set<string>;
  window: number;
}

export function initLineTailState(window = 1000): LineTailState {
  return { recent: [], recentSet: new Set(), window };
}

// Split a log blob into lines, return only those not already emitted in the
// recent window, and record them. Empty trailing line from a final "\n" is
// ignored. Note: identical consecutive log lines within one blob ARE collapsed
// (acceptable for a tail); the common case (distinct timestamped lines) streams
// faithfully.
export function acceptLines(state: LineTailState, blob: string): string[] {
  const lines = blob.split("\n").filter((l) => l.length > 0);
  const fresh: string[] = [];
  for (const line of lines) {
    if (state.recentSet.has(line)) continue;
    fresh.push(line);
    state.recent.push(line);
    state.recentSet.add(line);
  }
  // Trim the window from the front.
  while (state.recent.length > state.window) {
    const dropped = state.recent.shift();
    if (dropped !== undefined) state.recentSet.delete(dropped);
  }
  return fresh;
}
