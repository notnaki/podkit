#!/usr/bin/env node
import { createRegistry } from "./registry.ts";
import { devCommand } from "./commands/dev.ts";
import { dbCommand } from "./commands/db.ts";
import { authCommand } from "./commands/auth.ts";
import { deployCommand } from "./commands/deploy.ts";
import { docsCommand } from "./commands/docs.ts";
import { logsCommand } from "./commands/logs.ts";
import { analyticsCommand } from "./commands/analytics.ts";
import { cloudCommand } from "./commands/cloud.ts";

const registry = createRegistry();
registry.register("dev", devCommand);
registry.register("db", dbCommand);
registry.register("auth", authCommand);
registry.register("deploy", deployCommand);
registry.register("docs", docsCommand);
registry.register("logs", logsCommand);
registry.register("analytics", analyticsCommand);
registry.register("cloud", cloudCommand);

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const cleaned = argv.filter((a) => a !== "--json");

const result = await registry.dispatch(cleaned);

if (json) {
  console.log(JSON.stringify(result));
} else if (result.ok) {
  console.log("ready:", JSON.stringify(result.data));
} else {
  console.error(`error[${result.error.code}]: ${result.error.message}${result.error.hint ? `\n  hint: ${result.error.hint}` : ""}`);
}

if (!result.ok) process.exitCode = 1;
