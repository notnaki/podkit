#!/usr/bin/env node
import { createRegistry } from "./registry.ts";
import { devCommand } from "./commands/dev.ts";
import { dbCommand } from "./commands/db.ts";

const registry = createRegistry();
registry.register("dev", devCommand);
registry.register("db", dbCommand);

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
