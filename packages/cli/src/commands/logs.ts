import { join } from "node:path";
import { createSink, query, type EventFilter } from "@podkit/telemetry";
import { type Envelope, fail, ok } from "../envelope.ts";

export async function logsCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const file = join(process.cwd(), ".podkit/telemetry/events.jsonl");
    const events = createSink({ file }).all();

    const filter: EventFilter = { kind: "log" };
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--level") {
        filter.level = args[++i] as EventFilter["level"];
      } else if (flag === "--route") {
        filter.route = args[++i];
      } else if (flag === "--since") {
        filter.since = Number(args[++i]);
      }
    }

    return ok({ events: query(events, filter) });
  } catch (err) {
    return fail(err);
  }
}
