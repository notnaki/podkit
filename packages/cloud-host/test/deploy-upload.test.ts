import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  createReadStream,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { dropDatabase } from "@podkit/db-provision";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEST_LABEL = "podkit.test=1";

let pgContainer = "";
let connectionString = "";
let buildsRoot = "";
let dockerfileFixture = "";
let monorepoFixture = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";
let gatewayUrl = "";

// A second account's token, to prove cross-tenant 403.
let ownerToken = "";
let otherToken = "";

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

// Best-effort image cleanup for images this suite built.
async function cleanupImages(prefixes: string[]): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
    const toRemove = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((img) => prefixes.some((p) => img.startsWith(p)));
    for (const tag of toRemove) {
      try {
        await execFileAsync("docker", ["rmi", "-f", tag]);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// POST a raw body (Buffer or a file stream) to the control-plane and resolve
// { status, body } where body is the parsed JSON envelope (or raw text).
function postRaw(
  path: string,
  bodySource: Buffer | NodeJS.ReadableStream | null,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(apiUrl + path);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // keep raw
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (bodySource === null) {
      req.end();
    } else if (Buffer.isBuffer(bodySource)) {
      req.end(bodySource);
    } else {
      bodySource.pipe(req);
    }
  });
}

// tar -czf <out> -C <dir> . — package a directory into a gzip tarball.
async function tarDir(dir: string, out: string): Promise<void> {
  await execFileAsync("tar", ["-czf", out, "-C", dir, "."]);
}

beforeAll(async () => {
  pgContainer = "podkit-cp-" + randomBytes(4).toString("hex");
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
  if (!portMatch) throw new Error("could not parse postgres host port: " + portOut);
  connectionString = `postgres://postgres:pk@localhost:${portMatch[1]}/postgres`;
  await waitForPostgres(connectionString);

  // Confine uploads to the OS temp dir (an explicit opt-in sandbox).
  buildsRoot = realpathSync(tmpdir());
  process.env.PODKIT_BUILDS_ROOT = buildsRoot;

  // Dockerfile fixture: a tiny node http server.
  dockerfileFixture = mkdtempSync(join(tmpdir(), "podkit-upl-df-"));
  writeFileSync(
    join(dockerfileFixture, "Dockerfile"),
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
    join(dockerfileFixture, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "createServer((_req, res) => {",
      '  res.writeHead(200, { "content-type": "text/plain" });',
      '  res.end("hello from uploaded app");',
      "}).listen(3000);",
      "",
    ].join("\n"),
  );

  // Monorepo-like fixture: app lives under apps/api with its own Dockerfile.
  monorepoFixture = mkdtempSync(join(tmpdir(), "podkit-upl-mono-"));
  mkdirSync(join(monorepoFixture, "apps", "api"), { recursive: true });
  writeFileSync(join(monorepoFixture, "package.json"), '{"name":"root"}\n');
  writeFileSync(
    join(monorepoFixture, "apps", "api", "Dockerfile"),
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
    join(monorepoFixture, "apps", "api", "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "createServer((_req, res) => {",
      '  res.writeHead(200, { "content-type": "text/plain" });',
      '  res.end("hello from subpath app");',
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

  // Two accounts: owner (creates projects) and other (non-owner, for 403).
  const signup = async (email: string): Promise<string> => {
    const res = await fetch(apiUrl + "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const body = await res.json();
    return body.data.token as string;
  };
  ownerToken = await signup(`owner-${randomBytes(3).toString("hex")}@x.dev`);
  otherToken = await signup(`other-${randomBytes(3).toString("hex")}@x.dev`);
}, 180000);

afterAll(async () => {
  delete process.env.PODKIT_BUILDS_ROOT;
  if (cloud) {
    try {
      await cloud.close();
    } catch {
      // ignore
    }
  }
  for (const db of ["proj_upl", "proj_uplsub", "proj_uplmal", "proj_uplown"]) {
    try {
      await dropDatabase({ adminConnectionString: connectionString, database: db });
    } catch {
      // ignore
    }
  }
  if (pgContainer) {
    try {
      await execFileAsync("docker", ["rm", "-f", pgContainer]);
    } catch {
      // ignore
    }
  }
  for (const dir of [dockerfileFixture, monorepoFixture]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  await cleanupImages([
    "podkit-upl:v",
    "podkit-uplsub:v",
    "podkit-uplmal:v",
    "podkit-uplown:v",
  ]);
}, 120000);

// Create a project owned by ownerToken; asserts success.
async function createProject(slug: string, token = ownerToken): Promise<void> {
  const res = await fetch(apiUrl + "/v1/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slug }),
  });
  const body = await res.json();
  expect(body.ok).toBe(true);
}

describe("upload-based deploy (real Docker + Postgres)", () => {
  it(
    "tars a Dockerfile app, uploads it, and serves through the gateway",
    async () => {
      await createProject("upl");
      const tarPath = join(buildsRoot, `up-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(dockerfileFixture, tarPath);

      const res = await postRaw(
        "/v1/projects/upl/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        { "content-type": "application/gzip", authorization: `Bearer ${ownerToken}` },
      );
      rmSync(tarPath, { force: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.data.url).toBe("string");

      // Poll the gateway until the app responds.
      let served = "";
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(gatewayUrl + "/_p/upl/");
          const t = await r.text();
          if (t.includes("hello from uploaded app")) {
            served = t;
            break;
          }
        } catch {
          // ignore
        }
        await sleep(1000);
      }
      expect(served).toContain("hello from uploaded app");
    },
    180000,
  );

  it(
    "deploys an app under appSubpath from a monorepo tarball",
    async () => {
      await createProject("uplsub");
      const tarPath = join(buildsRoot, `up-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(monorepoFixture, tarPath);

      const res = await postRaw(
        "/v1/projects/uplsub/deploy-upload?containerPort=3000&appSubpath=apps/api",
        createReadStream(tarPath),
        { "content-type": "application/gzip", authorization: `Bearer ${ownerToken}` },
      );
      rmSync(tarPath, { force: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      let served = "";
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(gatewayUrl + "/_p/uplsub/");
          const t = await r.text();
          if (t.includes("hello from subpath app")) {
            served = t;
            break;
          }
        } catch {
          // ignore
        }
        await sleep(1000);
      }
      expect(served).toContain("hello from subpath app");
    },
    180000,
  );

  it(
    "rejects a malicious tarball with a ../ traversal entry (400, nothing escapes)",
    async () => {
      await createProject("uplmal");
      // Build a tarball whose listing contains a parent-dir entry. We craft a
      // dir with a benign file, then hand-build a tar that includes a ../ path.
      const malSrc = mkdtempSync(join(tmpdir(), "podkit-mal-"));
      writeFileSync(join(malSrc, "ok.txt"), "ok\n");
      const tarPath = join(buildsRoot, `mal-${randomBytes(4).toString("hex")}.tgz`);
      // Use a separate staging dir containing a real file, then add a ../ entry
      // via tar's --transform is not portable; instead create a parent file and
      // reference it with a relative path that climbs out.
      const stage = mkdtempSync(join(tmpdir(), "podkit-stage-"));
      const inner = join(stage, "inner");
      mkdirSync(inner);
      writeFileSync(join(stage, "escape.txt"), "PWNED\n");
      writeFileSync(join(inner, "good.txt"), "good\n");
      // From inside `inner`, "../escape.txt" climbs to the staging parent.
      await execFileAsync("tar", [
        "-czf",
        tarPath,
        "-C",
        inner,
        "good.txt",
        "../escape.txt",
      ]);

      const res = await postRaw(
        "/v1/projects/uplmal/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        { "content-type": "application/gzip", authorization: `Bearer ${ownerToken}` },
      );
      rmSync(tarPath, { force: true });
      rmSync(malSrc, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("E_BAD_ARGS");
    },
    120000,
  );

  it(
    "rejects a tarball containing an escaping symlink (400)",
    async () => {
      // Reuses the "uplmal" project created by the traversal test above.
      const linkSrc = mkdtempSync(join(tmpdir(), "podkit-link-"));
      // A symlink that points outside the (future) extraction dir.
      symlinkSync("/etc/passwd", join(linkSrc, "evil-link"));
      writeFileSync(join(linkSrc, "Dockerfile"), "FROM scratch\n");
      const tarPath = join(buildsRoot, `lnk-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(linkSrc, tarPath);

      const res = await postRaw(
        "/v1/projects/uplmal/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        { "content-type": "application/gzip", authorization: `Bearer ${ownerToken}` },
      );
      rmSync(tarPath, { force: true });
      rmSync(linkSrc, { recursive: true, force: true });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("E_BAD_ARGS");
    },
    120000,
  );

  it(
    "rejects an oversized upload with 413",
    async () => {
      // Reuses the "uplmal" project; the size guard runs after auth/ownership.
      // Stream a body larger than the 500 MiB cap WITHOUT allocating it all at
      // once: send repeated 8 MiB chunks until the server cuts us off. We push
      // ~520 MiB worth of chunks; the server should respond 413 well before the
      // end. We use a custom Readable so memory stays bounded.
      const { Readable } = await import("node:stream");
      const chunk = Buffer.alloc(8 * 1024 * 1024, 0); // 8 MiB of zeros
      let sent = 0;
      const target = 520 * 1024 * 1024; // 520 MiB > 500 MiB cap
      const body = new Readable({
        read() {
          if (sent >= target) {
            this.push(null);
            return;
          }
          sent += chunk.length;
          this.push(chunk);
        },
      });

      const res = await postRaw(
        "/v1/projects/uplmal/deploy-upload?containerPort=3000",
        body,
        { "content-type": "application/gzip", authorization: `Bearer ${ownerToken}` },
      );
      expect(res.status).toBe(413);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("E_PAYLOAD_TOO_LARGE");
    },
    120000,
  );

  it(
    "rejects an unauthenticated upload with 401",
    async () => {
      // The credential guard runs before project lookup, so no project needed.
      const tarPath = join(buildsRoot, `na-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(dockerfileFixture, tarPath);
      const res = await postRaw(
        "/v1/projects/uplmal/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        { "content-type": "application/gzip" },
      );
      rmSync(tarPath, { force: true });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("E_UNAUTHORIZED");
    },
    120000,
  );

  it(
    "returns 404 for an unknown project",
    async () => {
      const tarPath = join(buildsRoot, `nf-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(dockerfileFixture, tarPath);
      const res = await postRaw(
        "/v1/projects/does-not-exist-xyz/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        { "content-type": "application/gzip", authorization: `Bearer ${ownerToken}` },
      );
      rmSync(tarPath, { force: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("E_NOT_FOUND");
    },
    120000,
  );

  it(
    "returns 403 when a non-owner uploads to someone else's project",
    async () => {
      await createProject("uplown", ownerToken);
      const tarPath = join(buildsRoot, `fb-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(dockerfileFixture, tarPath);
      const res = await postRaw(
        "/v1/projects/uplown/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        { "content-type": "application/gzip", authorization: `Bearer ${otherToken}` },
      );
      rmSync(tarPath, { force: true });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("E_FORBIDDEN");
    },
    120000,
  );
});
