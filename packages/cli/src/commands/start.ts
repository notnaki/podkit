import { join, resolve } from "node:path";
import { createProdServer } from "@podkit/framework";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new PodkitError("E_BAD_ARGS", `Missing value for ${name}`, `Pass a value, e.g. ${name} 3000`);
  }
  return v;
}

export async function startCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const appRoot = resolve(flagValue(args, "--appRoot") ?? process.cwd());
    const buildDir = resolve(flagValue(args, "--buildDir") ?? join(appRoot, ".podkit", "build"));

    const portRaw = flagValue(args, "--port");
    let port: number;
    if (portRaw !== undefined) {
      const n = Number(portRaw);
      if (!Number.isInteger(n) || n < 0) {
        throw new PodkitError("E_BAD_ARGS", "Invalid --port value", "Pass an integer, e.g. --port 3000");
      }
      port = n;
    } else {
      port = 3000;
    }

    const server = await createProdServer({ appRoot, buildDir, port });
    if (server.routeCount === 0) {
      await server.close();
      throw new PodkitError("E_NO_ROUTES", "No routes found", "Run `podkit build` first");
    }
    const url = await server.listen();
    const boundPort = Number(new URL(url).port);
    // Sentinel line the buildpack e2e test polls for; must NOT mention vite/dev.
    console.log("prod server ready:", url);
    return ok({ url, port: boundPort });
  } catch (err) {
    return fail(err);
  }
}
