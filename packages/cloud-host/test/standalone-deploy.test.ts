import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  createReadStream,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { createCloud } from "../src/host.ts";
import { dropDatabase } from "@podkit/db-provision";

// End-to-end proof of the Vercel-like one-click standalone deploy:
//   (1) Copy examples/hello to a temp dir (simulate a STANDALONE app, NOT the
//       monorepo, with NO Dockerfile).
//   (2) Tar it (excluding node_modules/.git/.podkit, like the CLI does) and
//       upload to POST /v1/projects/:slug/deploy-upload?containerPort=3000 with
//       NO appSubpath — zero deploy flags beyond the slug.
//   (3) The control-plane detects isPodkitApp, builds standaloneMode=true via
//       the vendored podkit-base image (generateStandalonePodkitDockerfile),
//       runs the container, and waitForReadiness polls until it answers.
//   (4) The gateway serves /_p/test-hello/ — the SSR'd hello app.
//
// This requires the podkit-base image. We build it once in beforeAll (idempotent
// via `docker image inspect`) so the test is self-contained; the monorepo is
// small enough that this is a few seconds.

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_LABEL = "podkit.test=1";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const helloAppDir = join(repoRoot, "examples", "hello");
const BASE_IMAGE = "podkit-base:latest";

let pgContainer = "";
let connectionString = "";
let buildsRoot = "";
let standaloneAppDir = "";
let cloud: ReturnType<typeof createCloud> | null = null;
let apiUrl = "";
let gatewayUrl = "";
let ownerToken = "";

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

// Ensure the vendored base image exists locally (build it once if absent).
async function ensureBaseImage(): Promise<void> {
  try {
    await execFileAsync("docker", ["image", "inspect", BASE_IMAGE]);
    return;
  } catch {
    // Build it from infra/Dockerfile.base with the repo root as context.
  }
  await execFileAsync(
    "docker",
    [
      "build",
      "-f",
      join(repoRoot, "infra", "Dockerfile.base"),
      "-t",
      BASE_IMAGE,
      repoRoot,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

// Best-effort image cleanup for images this suite built (keeps the base image).
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

function postRaw(
  path: string,
  bodySource: NodeJS.ReadableStream,
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
    bodySource.pipe(req);
  });
}

// tar -czf <out> -C <dir> . excluding the heavy/irrelevant paths (mirrors the
// CLI's deployUpload tar). A pnpm-lock.yaml, if present, is included.
async function tarDir(dir: string, out: string): Promise<void> {
  await execFileAsync("tar", [
    "-czf",
    out,
    "--exclude=node_modules",
    "--exclude=.git",
    "--exclude=.podkit",
    "-C",
    dir,
    ".",
  ]);
}

beforeAll(async () => {
  await ensureBaseImage();

  pgContainer = "podkit-sa-cp-" + randomBytes(4).toString("hex");
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

  // Confine uploads to the OS temp dir (explicit opt-in sandbox).
  buildsRoot = realpathSync(tmpdir());
  process.env.PODKIT_BUILDS_ROOT = buildsRoot;

  // Simulate a STANDALONE app outside the monorepo: copy examples/hello (its
  // source only — node_modules/.podkit excluded) into a fresh temp dir. There is
  // NO Dockerfile and NO monorepo around it; just the app with app/routes and a
  // package.json depending on @podkit/* + react.
  standaloneAppDir = mkdtempSync(join(tmpdir(), "podkit-hello-standalone-"));
  cpSync(helloAppDir, standaloneAppDir, {
    recursive: true,
    filter: (src) =>
      !src.includes(`${join("examples", "hello", "node_modules")}`) &&
      !src.includes(`${join("examples", "hello", ".podkit")}`),
  });

  cloud = createCloud({
    controlPlaneConnectionString: connectionString,
    adminConnectionString: connectionString,
    apiKey: "k",
    baseImage: BASE_IMAGE,
  });
  const urls = await cloud.listen({ apiPort: 0, gatewayPort: 0 });
  apiUrl = urls.apiUrl;
  gatewayUrl = urls.gatewayUrl;

  const signup = async (email: string): Promise<string> => {
    const res = await fetch(apiUrl + "/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const body = await res.json();
    return body.data.token as string;
  };
  ownerToken = await signup(`sa-owner-${randomBytes(3).toString("hex")}@x.dev`);
}, 600000);

afterAll(async () => {
  delete process.env.PODKIT_BUILDS_ROOT;
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
      database: "test_hello",
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
  if (standaloneAppDir) {
    try {
      rmSync(standaloneAppDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  // Remove the per-deploy app images this suite built (keep the base image).
  await cleanupImages(["podkit-test-hello:v"]);
}, 180000);

async function createProject(slug: string): Promise<void> {
  const res = await fetch(apiUrl + "/v1/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ slug }),
  });
  const body = await res.json();
  expect(body.ok).toBe(true);
}

describe("one-click standalone podkit deploy (real Docker + Postgres)", () => {
  it(
    "builds a standalone hello app via the vendored base and serves it through the gateway with zero flags",
    async () => {
      await createProject("test-hello");

      // Tar the standalone app and upload it — NO appSubpath, NO Dockerfile.
      const tarPath = join(buildsRoot, `sa-${randomBytes(4).toString("hex")}.tgz`);
      await tarDir(standaloneAppDir, tarPath);

      const res = await postRaw(
        "/v1/projects/test-hello/deploy-upload?containerPort=3000",
        createReadStream(tarPath),
        {
          "content-type": "application/gzip",
          authorization: `Bearer ${ownerToken}`,
        },
      );
      rmSync(tarPath, { force: true });

      // The deploy returns 200 only AFTER waitForReadiness passed (the container
      // is provably serving before the route is set), so the gateway should
      // serve immediately. A non-200 here means the standalone build or readiness
      // poll failed — surface the body to aid debugging.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.data.url).toBe("string");
      expect(String(res.body.data.url)).toContain("/_p/test-hello/");

      // The gateway serves the SSR'd standalone app. Poll briefly for proxy
      // warm-up, but it should already be live.
      let served = "";
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(gatewayUrl + "/_p/test-hello/");
          const t = await r.text();
          if (t.includes("podkit home")) {
            served = t;
            break;
          }
        } catch {
          // ignore
        }
        await sleep(1000);
      }
      expect(served).toContain("podkit home");
      // It's a real SSR build: the hashed client entry is embedded.
      expect(served).toMatch(
        /<script type="module" src="\/client\/entry-[A-Za-z0-9_-]+\.js">/,
      );

      // A dynamic route also works (loader data embedded), proving the full
      // framework — not just a static page — is running from the standalone build.
      const blog = await fetch(gatewayUrl + "/_p/test-hello/blog/hello");
      const blogBody = await blog.text();
      expect(blog.status).toBe(200);
      expect(blogBody).toContain("post: hello");
    },
    600000,
  );
});
