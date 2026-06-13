import { createDevServer } from "@podkit/framework";
import { ok, fail, type Envelope } from "../envelope.ts";

export async function devCommand(args: string[]): Promise<Envelope<unknown>> {
  try {
    const portFlag = args.indexOf("--port");
    const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 3000;
    const server = await createDevServer({ appRoot: process.cwd(), port });
    const url = await server.listen();
    return ok({ url, port });
  } catch (err) {
    return fail(err);
  }
}
