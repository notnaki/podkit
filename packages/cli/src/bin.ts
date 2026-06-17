#!/usr/bin/env node
import { createRegistry } from "./registry.ts";
import { initCommand } from "./commands/init.ts";
import { devCommand } from "./commands/dev.ts";
import { buildCommand } from "./commands/build.ts";
import { startCommand } from "./commands/start.ts";
import { dbCommand } from "./commands/db.ts";
import { authCommand } from "./commands/auth.ts";
import { docsCommand } from "./commands/docs.ts";
import { logsCommand } from "./commands/logs.ts";
import { analyticsCommand } from "./commands/analytics.ts";
import { cloudCommand } from "./commands/cloud.ts";
import { exitCodeFor } from "./errors.ts";

const registry = createRegistry();
registry.register("init", initCommand);
registry.register("dev", devCommand);
registry.register("build", buildCommand);
registry.register("start", startCommand);
registry.register("db", dbCommand);
registry.register("auth", authCommand);
registry.register("docs", docsCommand);
registry.register("logs", logsCommand);
registry.register("analytics", analyticsCommand);
registry.register("cloud", cloudCommand);

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const quiet = argv.includes("--quiet");
const cleaned = argv.filter((a) => a !== "--json" && a !== "--quiet");

const result = await registry.dispatch(cleaned);

// stdout (json block + success line) is suppressed when quiet; stderr error line always prints.
if (!quiet) {
  if (json) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log("ready:", JSON.stringify(result.data));
  }
}

if (!result.ok) {
  console.error(`error[${result.error.code}]: ${result.error.message}${result.error.hint ? `\n  hint: ${result.error.hint}` : ""}`);
  process.exitCode = exitCodeFor(result.error.code);
}
