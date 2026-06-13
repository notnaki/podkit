import { createDevServer } from "@podkit/framework";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

export async function devCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const portFlag = args.indexOf("--port");
    let port: number;
    if (portFlag >= 0) {
      const raw = Number(args[portFlag + 1]);
      if (!Number.isInteger(raw) || raw < 0) {
        throw new PodkitError("E_BAD_ARGS", "Invalid --port value", "Pass an integer, e.g. --port 3000");
      }
      port = raw;
    } else {
      port = 3000;
    }
    const server = await createDevServer({ appRoot: process.cwd(), port });
    if (server.routeCount === 0) {
      await server.close();
      throw new PodkitError("E_NO_ROUTES", "No routes found", "Create app/routes/index.tsx");
    }
    const url = await server.listen();
    const boundPort = Number(new URL(url).port);
    return ok({ url, port: boundPort });
  } catch (err) {
    return fail(err);
  }
}
