import { type Envelope, ok, fail } from "../envelope.ts";
import { PodkitError } from "../errors.ts";
import { listTopics, getDoc, describeProject } from "@podkit/docs";

export async function docsCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const arg = args[0];
    if (arg === undefined) {
      return ok({ topics: listTopics() });
    }
    if (arg === "project") {
      return ok(describeProject({ appRoot: process.cwd() }));
    }
    const doc = getDoc(arg);
    if (doc === null) {
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          "unknown doc topic: " + arg,
          "Available topics: " + listTopics().join(", "),
        ),
      );
    }
    return ok(doc);
  } catch (err) {
    return fail(err);
  }
}
