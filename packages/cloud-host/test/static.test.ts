import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pgContainer = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";
let consoleDir = "";

const INDEX_HTML = "<!doctype html><html><body>podkit cloud console</body></html>";

async function waitForPostgres(connStr: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ connectionString: connStr });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* ignore */ }
      await sleep(500);
    }
  }
  throw new Error("Postgres did not become ready");
}

beforeAll(async () => {
  pgContainer = "podkit-static-" + randomBytes(8).toString("hex");
  await execFileAsync("docker", [
    "run", "-d", "--rm", "--label", "podkit.test=1", "--name", pgContainer,
    "-e", "POSTGRES_PASSWORD=pk", "-p", "0:5432", "postgres:16-alpine",
  ]);
  const { stdout } = await execFileAsync("docker", ["port", pgContainer, "5432"]);
  const port = /:(\d+)\s*$/.exec(stdout.trim().split("\n")[0]!)![1]!;
  const conn = `postgres://postgres:pk@localhost:${port}/postgres`;
  await waitForPostgres(conn);

  // A minimal built-console fixture: index.html + an asset.
  consoleDir = mkdtempSync(join(tmpdir(), "podkit-console-"));
  writeFileSync(join(consoleDir, "index.html"), INDEX_HTML);
  mkdirSync(join(consoleDir, "assets"));
  writeFileSync(join(consoleDir, "assets", "app.js"), "console.log('podkit')");

  cloud = createCloud({
    controlPlaneConnectionString: conn,
    adminConnectionString: conn,
    apiKey: "k",
    consoleDir,
  });
  apiUrl = (await cloud.listen({ apiPort: 0, gatewayPort: 0 })).apiUrl;
}, 120000);

afterAll(async () => {
  try { await cloud?.close(); } catch { /* ignore */ }
  if (pgContainer) { try { await execFileAsync("docker", ["rm", "-f", pgContainer]); } catch { /* ignore */ } }
  if (consoleDir) { try { rmSync(consoleDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}, 120000);

describe("control-plane serves the console (real Docker + Postgres)", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(apiUrl + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("podkit cloud console");
  });

  it("serves static assets with a js content-type", async () => {
    const res = await fetch(apiUrl + "/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("SPA-falls-back to index.html for extensionless routes", async () => {
    const res = await fetch(apiUrl + "/projects/some-app");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("podkit cloud console");
  });

  it("still serves the API under /v1", async () => {
    const res = await fetch(apiUrl + "/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });

  it("404s a missing asset (has an extension)", async () => {
    const res = await fetch(apiUrl + "/assets/missing.js");
    expect(res.status).toBe(404);
  });
});
