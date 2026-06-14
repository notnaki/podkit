import { join, resolve } from "node:path";
import { buildApp } from "@podkit/framework";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new PodkitError("E_BAD_ARGS", `Missing value for ${name}`, `Pass a path, e.g. ${name} ./app`);
  }
  return v;
}

export async function buildCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const appRoot = resolve(flagValue(args, "--appRoot") ?? process.cwd());
    const outDir = resolve(flagValue(args, "--outDir") ?? join(appRoot, ".podkit", "build"));

    const result = await buildApp(appRoot, outDir);
    if (result.routeCount === 0) {
      throw new PodkitError("E_NO_ROUTES", "No routes found", "Create app/routes/index.tsx");
    }
    return ok({
      outDir: result.outDir,
      routeCount: result.routeCount,
      clientEntry: result.clientEntry,
    });
  } catch (err) {
    return fail(err);
  }
}
