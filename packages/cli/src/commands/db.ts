import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createDbClient } from "@podkit/db";
import { generateMigration } from "@podkit/db";
import { applyMigrations } from "@podkit/db";
import { pullSchema } from "@podkit/db";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

export async function dbCommand(args: string[]): Promise<Envelope<unknown>> {
  const [subcommand] = args;

  const appRoot = process.cwd();
  const schemaPath = join(appRoot, "app/db/schema.ts");
  const migrationsDir = join(appRoot, "app/db/migrations");
  const dataDir = join(appRoot, ".podkit/pgdata");

  try {
    // Ensure directories exist before handing them to PGlite / drizzle-kit
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });

    if (subcommand === "migrate") {
      // Generate a migration from the current schema. drizzle-kit may exit
      // non-zero when there is no schema diff; tolerate ONLY that case and
      // surface every other (real) generate failure.
      try {
        await generateMigration({ schemaPath, outDir: migrationsDir });
      } catch (genErr) {
        const msg = genErr instanceof Error ? genErr.message : String(genErr);
        if (!/no schema changes|nothing to (do|migrate)/i.test(msg)) throw genErr;
      }

      const client = createDbClient({ dataDir });
      try {
        const { applied } = await applyMigrations({ client, dir: migrationsDir });
        return ok({ migrationsDir, applied });
      } finally {
        await client.close();
      }
    }

    if (subcommand === "pull") {
      const client = createDbClient({ dataDir });
      try {
        const { migrationFile, tables } = await pullSchema({
          client,
          outDir: migrationsDir,
          timestamp: Date.now(),
        });
        return ok({ migrationFile, tables });
      } finally {
        await client.close();
      }
    }

    if (subcommand === "studio") {
      return fail(
        new PodkitError(
          "E_NOT_IMPLEMENTED",
          "podkit db studio is not available yet",
          "Use `podkit db migrate` / `podkit db pull` for now",
        ),
      );
    }

    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        subcommand
          ? `Unknown db subcommand: ${subcommand}`
          : "No db subcommand given",
        "Available db subcommands: migrate, pull, studio",
      ),
    );
  } catch (err) {
    return fail(err);
  }
}
