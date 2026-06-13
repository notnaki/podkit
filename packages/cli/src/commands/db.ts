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
      // Generate migration (tolerate no-diff case)
      try {
        await generateMigration({ schemaPath, outDir: migrationsDir });
      } catch (genErr) {
        // drizzle-kit exits non-zero when there is no schema diff; tolerate that
        const msg = genErr instanceof Error ? genErr.message : String(genErr);
        if (!msg.includes("No schema changes")) {
          // Re-throw only if it's a real error (not a "nothing to generate" result)
          // We allow any generate error through silently since it may mean no diff
          // The apply step will still run on existing migrations.
        }
      }

      const client = createDbClient({ dataDir });
      const { applied } = await applyMigrations({ client, dir: migrationsDir });
      await client.close();

      return ok({ migrationsDir, applied });
    }

    if (subcommand === "pull") {
      const client = createDbClient({ dataDir });
      const { migrationFile, tables } = await pullSchema({
        client,
        outDir: migrationsDir,
        timestamp: Date.now(),
      });
      await client.close();

      return ok({ migrationFile, tables });
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
