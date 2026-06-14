import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { dropDatabase } from "@podkit/db-provision";
import { containerLogs } from "@podkit/runtime";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEST_LABEL = "podkit.test=1";

let pgContainer = "";
let connectionString = "";
let fixtureDir = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";
let gatewayUrl = "";

async function waitForPostgres(connStr: string, attempts = 60): Promise<void> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const client = new Client({ connectionString: connStr });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastErr = err;
      try {
        await client.end();
      } catch {
        // ignore
      }
      await sleep(1000);
    }
  }
  throw new Error(
    "Postgres did not become ready: " +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

// fetch() forbids overriding the Host header, so use a raw node:http request to
// prove Host-header (custom domain) routing through the gateway.
function getWithHost(
  url: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        method: "GET",
        path: u.pathname + u.search,
        headers: { host: hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  pgContainer = "podkit-cp-dom-" + randomBytes(4).toString("hex");
  await execFileAsync("docker", [
    "run",
    "-d",
    "--rm",
    "--label",
    TEST_LABEL,
    "--name",
    pgContainer,
    "-e",
    "POSTGRES_PASSWORD=pk",
    "-p",
    "0:5432",
    "postgres:16-alpine",
  ]);

  const { stdout: portOut } = await execFileAsync("docker", [
    "port",
    pgContainer,
    "5432",
  ]);
  const portMatch = /:(\d+)\s*$/.exec(portOut.trim().split("\n")[0]!);
  if (!portMatch) {
    throw new Error("could not parse postgres host port: " + portOut);
  }
  const pgPort = portMatch[1]!;
  connectionString = `postgres://postgres:pk@localhost:${pgPort}/postgres`;

  await waitForPostgres(connectionString);

  // Build a fixture app context dir with a known response string.
  fixtureDir = mkdtempSync(join(tmpdir(), "podkit-dom-app-"));
  writeFileSync(
    join(fixtureDir, "Dockerfile"),
    [
      "FROM node:22-alpine",
      "WORKDIR /app",
      "COPY server.mjs .",
      "EXPOSE 3000",
      "CMD node server.mjs",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureDir, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "createServer((_req, res) => {",
      '  res.writeHead(200, { "content-type": "text/plain" });',
      '  res.end("hello from custom domain app");',
      "}).listen(3000);",
      "",
    ].join("\n"),
  );

  cloud = createCloud({
    controlPlaneConnectionString: connectionString,
    adminConnectionString: connectionString,
    apiKey: "k",
  });
  const urls = await cloud.listen({ apiPort: 0, gatewayPort: 0 });
  apiUrl = urls.apiUrl;
  gatewayUrl = urls.gatewayUrl;
}, 120000);

afterAll(async () => {
  if (cloud) {
    try {
      await cloud.close();
    } catch {
      // ignore
    }
  }
  try {
    await dropDatabase({
      adminConnectionString: connectionString,
      database: "proj_domdemo",
    });
  } catch {
    // ignore
  }
  if (pgContainer) {
    try {
      await execFileAsync("docker", ["rm", "-f", pgContainer]);
    } catch {
      // ignore
    }
  }
  // Scope the leftover-container check to this suite's own containers so a
  // sibling suite running in parallel doesn't cause a false failure.
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    "label=" + TEST_LABEL,
    "--format",
    "{{.Names}}",
  ]);
  const leftover = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((n) => n === pgContainer || n.startsWith("podkit-app-domdemo-"));
  expect(leftover).toEqual([]);
}, 120000);

describe("cloud-host custom domains (real Docker + Postgres)", () => {
  it(
    "routes a request by Host header to the deployed app",
    async () => {
      const domain = "demo.podkit.test";

      // 1. Create project (+ managed DB).
      const createRes = await fetch(apiUrl + "/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ slug: "domdemo", owner: "me" }),
      });
      expect((await createRes.json()).ok).toBe(true);

      // 2. Deploy the fixture app.
      const deployRes = await fetch(apiUrl + "/v1/projects/domdemo/deploy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ contextDir: fixtureDir, containerPort: 3000 }),
      });
      expect((await deployRes.json()).ok).toBe(true);

      // 3. Unauthenticated POST domain -> 401.
      const unauthRes = await fetch(apiUrl + "/v1/projects/domdemo/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      expect(unauthRes.status).toBe(401);
      expect((await unauthRes.json()).error.code).toBe("E_UNAUTHORIZED");

      // 4. Invalid domain -> 400 E_BAD_ARGS.
      const badRes = await fetch(apiUrl + "/v1/projects/domdemo/domains", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ domain: "no-dot" }),
      });
      expect(badRes.status).toBe(400);
      expect((await badRes.json()).error.code).toBe("E_BAD_ARGS");

      // 5. Add the domain.
      const addRes = await fetch(apiUrl + "/v1/projects/domdemo/domains", {
        method: "POST",
        headers: { "content-type": "application/json", "x-podkit-key": "k" },
        body: JSON.stringify({ domain }),
      });
      const addBody = await addRes.json();
      expect(addBody.ok).toBe(true);
      expect(addBody.data.domain).toBe(domain);

      // 6. GET lists it.
      const listRes = await fetch(apiUrl + "/v1/projects/domdemo/domains", {
        headers: { "x-podkit-key": "k" },
      });
      const listBody = await listRes.json();
      expect(listBody.ok).toBe(true);
      expect(listBody.data.domains).toEqual([{ domain }]);

      // 7. Raw request to the gateway with Host = custom domain -> app response.
      let served = "";
      let lastErr: unknown = null;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await getWithHost(gatewayUrl + "/", domain);
          if (res.body.includes("hello from custom domain app")) {
            served = res.body;
            break;
          }
          lastErr = "status=" + res.status + " body=" + res.body;
        } catch (err) {
          lastErr = err;
        }
        await sleep(1000);
      }
      if (!served.includes("hello from custom domain app")) {
        let logs = "";
        try {
          const { stdout } = await execFileAsync("docker", [
            "ps",
            "-a",
            "--filter",
            "label=" + TEST_LABEL,
            "--format",
            "{{.Names}}",
          ]);
          for (const name of stdout.trim().split("\n").filter(Boolean)) {
            if (name.startsWith("podkit-app-")) {
              logs += `\n--- logs ${name} ---\n` + (await containerLogs(name));
            }
          }
        } catch {
          // ignore
        }
        throw new Error(
          "gateway never served the app via Host header. last=" +
            String(lastErr) +
            logs,
        );
      }
      expect(served).toContain("hello from custom domain app");

      // 8. DELETE removes the domain (route + map).
      const delRes = await fetch(
        apiUrl + "/v1/projects/domdemo/domains/" + domain,
        {
          method: "DELETE",
          headers: { "x-podkit-key": "k" },
        },
      );
      const delBody = await delRes.json();
      expect(delBody.ok).toBe(true);
      expect(delBody.data.deleted).toBe(domain);

      // After deletion the Host route no longer resolves -> 502 E_NO_ROUTE.
      const afterDel = await getWithHost(gatewayUrl + "/", domain);
      expect(afterDel.status).toBe(502);

      // And GET no longer lists it.
      const listRes2 = await fetch(apiUrl + "/v1/projects/domdemo/domains", {
        headers: { "x-podkit-key": "k" },
      });
      expect((await listRes2.json()).data.domains).toEqual([]);
    },
    180000,
  );
});
