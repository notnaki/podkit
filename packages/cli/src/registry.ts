import { type Envelope, fail } from "./envelope.ts";
import { PodkitError } from "./errors.ts";

export type CommandHandler = (args: string[]) => Promise<Envelope<unknown>>;

export function createRegistry() {
  const commands = new Map<string, CommandHandler>();
  return {
    register(name: string, handler: CommandHandler) {
      commands.set(name, handler);
    },
    async dispatch(argv: string[]): Promise<Envelope<unknown>> {
      const [name, ...rest] = argv;
      const handler = name ? commands.get(name) : undefined;
      if (!handler) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            name ? `Unknown command: ${name}` : "No command given",
            `Available commands: ${[...commands.keys()].join(", ") || "(none)"}`,
          ),
        );
      }
      return handler(rest);
    },
  };
}
