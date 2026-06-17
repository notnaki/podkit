import { join } from "node:path";
import { createSink, query, type EventFilter, type TelemetryEvent } from "@podkit/telemetry";
import { type Envelope, fail, ok } from "../envelope.ts";
import { accept, initTailState } from "./tail.ts";

// A source for follow mode: given a `since` cursor, return the current batch of
// matching log events (ts ascending). Injectable so the follow loop can be
// tested against a fake source returning growing batches — no live server or
// real clock needed.
export type LogSource = (since: number | undefined) => Promise<TelemetryEvent[]>;

export interface FollowDeps {
  source: LogSource;
  // Called once per genuinely-new line. Defaults to printing JSON to stdout.
  emit?: (e: TelemetryEvent) => void;
  // Sleep between polls; injectable so tests don't wait on a real clock.
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  // When this resolves/returns true, the loop stops. Defaults to never (until
  // the process is interrupted with Ctrl-C). Tests pass a bounded predicate.
  stop?: () => boolean;
}

function parseFilter(args: string[]): { filter: EventFilter; follow: boolean } {
  const filter: EventFilter = { kind: "log" };
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--level") {
      filter.level = args[++i] as EventFilter["level"];
    } else if (flag === "--route") {
      filter.route = args[++i];
    } else if (flag === "--since") {
      filter.since = Number(args[++i]);
    } else if (flag === "--follow" || flag === "-f") {
      follow = true;
    }
  }
  return { filter, follow };
}

// The streaming loop. Polls `source` with a moving cursor and emits only lines
// newer than the last seen one, de-duping the inclusive `?since` boundary. Runs
// until `stop()` returns true (the CLI never stops it; Ctrl-C kills the process).
//
// ponytail: client-side polling, NOT server push (no SSE/websocket). Upgrade
// path documented in tail.ts.
export async function followLogs(deps: FollowDeps, initialSince?: number): Promise<void> {
  const emit = deps.emit ?? ((e) => process.stdout.write(JSON.stringify(e) + "\n"));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = deps.intervalMs ?? 1500;
  const stop = deps.stop ?? (() => false);

  const state = initTailState(initialSince);

  while (!stop()) {
    const batch = await deps.source(state.since);
    for (const e of accept(state, batch)) emit(e);
    if (stop()) break;
    await sleep(intervalMs);
  }
}

export async function logsCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const file = join(process.cwd(), ".podkit/telemetry/events.jsonl");
    const sink = createSink({ file });
    const { filter, follow } = parseFilter(args);

    if (follow) {
      // Local-file follow: re-read the JSONL and re-filter each poll. The sink
      // tolerates partially-written trailing lines, and `accept()` de-dupes the
      // inclusive `since` boundary, so growing files stream cleanly.
      const source: LogSource = async (since) =>
        query(sink.all(), { ...filter, since });
      await followLogs({ source }, filter.since);
      return ok({ followed: true });
    }

    return ok({ events: query(sink.all(), filter) });
  } catch (err) {
    return fail(err);
  }
}
