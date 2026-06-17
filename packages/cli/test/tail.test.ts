import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "@podkit/telemetry";
import {
  accept,
  acceptLines,
  initLineTailState,
  initTailState,
} from "../src/commands/tail.ts";
import { followLogs, type LogSource } from "../src/commands/logs.ts";
import { followCloudLogs } from "../src/commands/cloud.ts";

function logAt(ts: number, message: string): TelemetryEvent {
  return { ts, kind: "log", level: "info", message };
}

describe("accept (event cursor/dedup)", () => {
  it("emits only newer events across growing batches and never repeats", () => {
    const state = initTailState();

    const poll1 = accept(state, [logAt(1, "a"), logAt(2, "b")]);
    expect(poll1.map((e) => e.message)).toEqual(["a", "b"]);

    // Second poll re-includes the boundary event (inclusive since) plus a new one.
    const poll2 = accept(state, [logAt(2, "b"), logAt(3, "c")]);
    expect(poll2.map((e) => e.message)).toEqual(["c"]);

    // Idle poll: same batch again -> nothing new.
    const poll3 = accept(state, [logAt(3, "c")]);
    expect(poll3).toEqual([]);
  });

  it("does not collapse two distinct events sharing the boundary timestamp", () => {
    const state = initTailState();
    accept(state, [logAt(5, "first")]);
    // Same ts, different message -> genuinely new line at the boundary.
    const next = accept(state, [logAt(5, "first"), logAt(5, "second")]);
    expect(next.map((e) => e.message)).toEqual(["second"]);
  });

  it("drops events older than the cursor and malformed entries", () => {
    const state = initTailState(10);
    const out = accept(state, [
      logAt(5, "old"),
      { kind: "log", message: "no-ts" } as unknown as TelemetryEvent,
      logAt(11, "new"),
    ]);
    expect(out.map((e) => e.message)).toEqual(["new"]);
  });
});

describe("followLogs (local JSONL follow loop)", () => {
  it("streams growing batches once each and stops on predicate", async () => {
    const batches: TelemetryEvent[][] = [
      [logAt(1, "a")],
      [logAt(1, "a"), logAt(2, "b")],
      [logAt(1, "a"), logAt(2, "b"), logAt(3, "c")],
    ];
    let poll = 0;
    const source: LogSource = async () => batches[Math.min(poll, batches.length - 1)]!;

    const emitted: string[] = [];
    await followLogs({
      source,
      emit: (e) => emitted.push(e.message ?? ""),
      sleep: async () => {
        poll++;
      },
      stop: () => poll >= 3,
    });

    expect(emitted).toEqual(["a", "b", "c"]);
  });
});

describe("acceptLines (raw log-line dedup)", () => {
  it("emits new lines and drops repeats from the inclusive overlap", () => {
    const state = initLineTailState();
    expect(acceptLines(state, "l1\nl2\n")).toEqual(["l1", "l2"]);
    // Next poll overlaps the boundary line then adds a new one.
    expect(acceptLines(state, "l2\nl3\n")).toEqual(["l3"]);
    expect(acceptLines(state, "l3\n")).toEqual([]);
  });

  it("evicts lines beyond the window so old text can reappear", () => {
    const state = initLineTailState(2);
    acceptLines(state, "a\nb\n");
    acceptLines(state, "c\n"); // window now holds [b, c]; "a" evicted
    expect(acceptLines(state, "a\n")).toEqual(["a"]);
  });
});

describe("followCloudLogs (SSE stream follow)", () => {
  it("parses SSE events and emits each log line", async () => {
    // Build a minimal fake SSE body: two data events.
    const sseBody =
      ': connected\n\n' +
      'data: {"line":"line1"}\n\n' +
      'data: {"line":"line2"}\n\n';

    const encoder = new TextEncoder();
    const encoded = encoder.encode(sseBody);

    // A one-shot ReadableStream that yields the whole body then closes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });

    const emitted: string[] = [];
    await followCloudLogs("myapp", {
      fetchStream: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      emit: (line) => emitted.push(line),
    });

    expect(emitted).toEqual(["line1", "line2"]);
  });

  it("returns a network error when fetchStream rejects", async () => {
    const result = await followCloudLogs("myapp", {
      fetchStream: async () => { throw new Error("conn refused"); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_NETWORK");
    }
  });
});
