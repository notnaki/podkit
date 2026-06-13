import { join } from "node:path";
import { aggregate, createSink } from "@podkit/telemetry";
import { type Envelope, fail, ok } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

export async function analyticsCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const subcommand = args[0];
    if (subcommand === "query") {
      const file = join(process.cwd(), ".podkit/telemetry/events.jsonl");
      const events = createSink({ file }).all();
      return ok({ counts: aggregate(events) });
    }
    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        subcommand ? `Unknown analytics subcommand: ${subcommand}` : "No analytics subcommand given",
        "Available analytics subcommands: query",
      ),
    );
  } catch (err) {
    return fail(err);
  }
}
