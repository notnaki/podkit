import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";
import { readAuth, writeAuth, clearAuth } from "../auth-store.ts";

type Method = "GET" | "POST" | "DELETE" | "PUT";

function resolveBase(): string {
  return readAuth()?.url ?? process.env.PODKIT_API_URL ?? "http://localhost:8080";
}

function resolveToken(): string | null {
  return readAuth()?.token ?? null;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = resolveToken();
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  } else {
    headers["x-podkit-key"] = process.env.PODKIT_API_KEY ?? "";
  }
  return headers;
}

async function callControlPlane(
  method: Method,
  path: string,
  body?: unknown,
): Promise<Envelope<unknown>> {
  const base = resolveBase();

  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return fail(
      new PodkitError(
        "E_NETWORK",
        "control-plane unreachable",
        "is it running? set PODKIT_API_URL",
      ),
    );
  }

  return (await response.json()) as Envelope<unknown>;
}

type Spawn = typeof spawn;

// Injectable for testing; defaults to node:child_process spawn.
let spawnImpl: Spawn = spawn;

export function __setSpawnForTest(impl: Spawn | null): void {
  spawnImpl = impl ?? spawn;
}

// Tar-and-stream a context directory to the upload-based deploy endpoint. We
// `tar -czf -` the context (excluding heavy/irrelevant dirs) and pipe its stdout
// straight into an HTTP request body as application/gzip — the full tarball is
// NEVER buffered in memory on either side. Auth headers mirror callControlPlane
// (Bearer token, else x-podkit-key). Returns the parsed platform Envelope.
async function deployUpload(
  slug: string,
  contextDir: string,
  containerPort: number,
  appSubpath: string | null,
  branchName?: string | null,
): Promise<Envelope<unknown>> {
  const base = resolveBase();
  let url: URL;
  try {
    const path =
      `/v1/projects/${encodeURIComponent(slug)}/deploy-upload` +
      `?containerPort=${encodeURIComponent(String(containerPort))}` +
      (appSubpath ? `&appSubpath=${encodeURIComponent(appSubpath)}` : "") +
      (branchName ? `&branchName=${encodeURIComponent(branchName)}` : "");
    url = new URL(base + path);
  } catch {
    return fail(new PodkitError("E_BAD_ARGS", "invalid control-plane URL"));
  }

  // Build tar argv. --exclude trims the common heavy/irrelevant paths so uploads
  // stay small (and well under the server's size cap). -C <dir> + "." keeps the
  // archive rooted at the context dir (no absolute paths, no leading parent).
  const tarArgs = [
    "-czf",
    "-",
    "--exclude=node_modules",
    "--exclude=.git",
    // Exclude the whole .podkit dir: it holds locally-generated artifacts only —
    // the prod build output, the pglite dev database (.podkit/appdata, a full
    // Postgres data dir with a pid file and tablespace symlinks), and telemetry.
    // Running `podkit dev` before deploying creates these; uploading them bloats
    // the tar and trips the control-plane's symlink/traversal audit. The cloud
    // rebuilds .podkit/build itself, so none of it is needed.
    "--exclude=.podkit",
    "-C",
    contextDir,
    ".",
  ];

  const headers: Record<string, string> = {
    "content-type": "application/gzip",
  };
  const token = resolveToken();
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  } else {
    headers["x-podkit-key"] = process.env.PODKIT_API_KEY ?? "";
  }

  return await new Promise<Envelope<unknown>>((resolvePromise) => {
    let settled = false;
    const finish = (env: Envelope<unknown>) => {
      if (settled) return;
      settled = true;
      resolvePromise(env);
    };

    const tar = spawnImpl("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // COPYFILE_DISABLE stops macOS bsdtar from emitting AppleDouble "._*"
      // sidecar files for entries that carry extended attributes (e.g.
      // com.apple.provenance). Those vanish on a macOS extract but GNU tar in
      // the Linux build container extracts them as real files — so a "._index.tsx"
      // lands in app/routes and the build chokes trying to compile binary xattr
      // data. Without this, every deploy from a Mac fails.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    let tarStderr = "";
    if (tar.stderr) {
      tar.stderr.on("data", (chunk: unknown) => {
        tarStderr += String(chunk);
      });
    }
    tar.on("error", () => {
      finish(
        fail(
          new PodkitError(
            "E_BAD_STATE",
            "could not run tar to package the context",
            "is tar installed and on PATH?",
          ),
        ),
      );
    });

    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        protocol: url.protocol,
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
          const status = res.statusCode ?? 0;
          // Map server status codes to friendly, actionable CLI errors.
          if (status === 413) {
            finish(
              fail(
                new PodkitError(
                  "E_BAD_STATE",
                  "upload too large (server returned 413)",
                  "exclude node_modules/.git/.podkit (already excluded) or remove large files",
                ),
              ),
            );
            return;
          }
          if (status === 400) {
            // The server rejected the tarball (malformed, traversal, etc.).
            // Surface its message when present, else a generic repack hint.
            let serverMsg = "the server rejected the uploaded tarball";
            try {
              const parsed = JSON.parse(raw) as Envelope<unknown>;
              if (!parsed.ok && parsed.error?.message) {
                serverMsg = parsed.error.message;
              }
            } catch {
              // fall through to generic message
            }
            finish(
              fail(
                new PodkitError(
                  "E_BAD_ARGS",
                  serverMsg,
                  "ensure the tarball is a clean gzip of your project (try repacking)",
                ),
              ),
            );
            return;
          }
          try {
            finish(JSON.parse(raw) as Envelope<unknown>);
          } catch {
            finish(
              fail(
                new PodkitError(
                  "E_NETWORK",
                  "unexpected response from control-plane",
                ),
              ),
            );
          }
        });
      },
    );

    req.on("error", () => {
      try {
        tar.kill();
      } catch {
        // best-effort
      }
      finish(
        fail(
          new PodkitError(
            "E_NETWORK",
            "control-plane unreachable",
            "is it running? set PODKIT_API_URL",
          ),
        ),
      );
    });

    tar.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        try {
          req.destroy();
        } catch {
          // best-effort
        }
        finish(
          fail(
            new PodkitError(
              "E_BAD_STATE",
              "tar exited with a non-zero status while packaging the context",
              tarStderr.trim() || undefined,
            ),
          ),
        );
      }
    });

    // Pipe tar stdout -> request body. node:http chunks the stream; the server
    // streams it to disk, so neither side buffers the whole archive.
    if (tar.stdout) {
      tar.stdout.pipe(req);
    } else {
      req.end();
    }
  });
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawnImpl(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {
      // opener missing; the URL is printed anyway
    });
    child.unref();
  } catch {
    // ignore; the URL is printed anyway
  }
}

// Pure string padding: build an aligned, dashed-rule table from row objects.
// Columns are derived from the first row's keys; widths via Math.max over
// header + cell lengths. No eval, no execution.
export function formatTable(rows: Record<string, string>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => (row[col] ?? "").length)),
  );
  const pad = (value: string, width: number): string =>
    value + " ".repeat(width - value.length);
  const header = columns.map((col, i) => pad(col, widths[i])).join(" | ");
  const rule = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = rows.map((row) =>
    columns.map((col, i) => pad(row[col] ?? "", widths[i])).join(" | "),
  );
  return [header, rule, ...body].join("\n");
}

type StartResponse = {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  pollInterval?: number;
};

type PollResponse = {
  status: string;
  token?: string;
};

const AVAILABLE =
  "Available: projects, create <slug>, deploy <slug> (one-click; flags optional: [--contextDir=<dir>] [--containerPort=3000] [--appSubpath=<path>]), url <slug>, open <slug>, status <slug>, deployments <slug>, rollback <slug> <deploymentId>, logs <slug> [--follow|-f], env, domains, branches, cron, preview <slug> <branchName>, blob, members <slug>, invite <slug> <email> [role], invite accept <token>, member rm <slug> <accountId>, login [--url <url>], logout, whoami";

const MEMBERS_HINT = "podkit cloud members <slug> [--table]";
const INVITE_HINT =
  "podkit cloud invite <slug> <email> [role] | invite accept <token>";

// `deploy` is one-click: from your app directory, run `podkit cloud deploy <slug>`
// with NO other flags. The CLI tars the current directory (excluding
// node_modules/.git/.podkit), streams it to the control-plane, and the
// control-plane builds a standalone podkit app (no Dockerfile needed) on the
// vendored base image. All flags are OPTIONAL:
//   --contextDir   directory to deploy (default: current directory)
//   --containerPort the app's port inside the container (default: 3000 — the
//                   podkit convention; standalone apps are locked to it, add an
//                   explicit Dockerfile to opt out)
//   --appSubpath   ONLY for monorepo deploys: path to the app within a full
//                  monorepo tarball (e.g. apps/myapp). Omit for standalone apps.
// An explicit Dockerfile in the context always wins (full opt-out).
const DEPLOY_HINT =
  "podkit cloud deploy <slug>  (one-click; all flags optional: [--contextDir=<dir>] [--containerPort=3000] [--appSubpath=apps/myapp])";

const ENV_HINT =
  "podkit cloud env set <slug> KEY=VALUE | list <slug> | rm <slug> KEY";

const DOMAINS_HINT =
  "podkit cloud domains add <slug> <domain> | list <slug> | rm <slug> <domain>";

const BRANCHES_HINT =
  "podkit cloud branches list <slug> | create <slug> <name> | rm <slug> <name>";

const PREVIEW_HINT =
  "podkit cloud preview <slug> <branchName> [--contextDir=<dir>] [--containerPort=<port>] | preview list <slug>";

const BLOB_HINT =
  "podkit cloud blob put <slug> <key> <file> | get <slug> <key> [outFile] | ls <slug> [--table] | rm <slug> <key> | url <slug> <key> [--exp <sec>]";

const CRON_HINT =
  "podkit cloud cron add <slug> <name> <schedule> <path> [--method=GET|POST] | list <slug> [--table] | rm <slug> <name>  (schedule: @hourly, @daily, @every <N>m, @every <N>h, */<N>)";

// Parse a `--flag=value` style option out of an argv slice. Returns null when
// the flag is absent or has no value.
function parseFlag(args: string[], flag: string): string | null {
  const prefix = flag + "=";
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE log streaming (replaces the old poll loop for `--follow`).
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE chunk buffer into complete `data: ...` lines.
 * Returns the parsed JSON values (one per `data:` line in a double-newline
 * delimited event). Leftover bytes are returned as the new `buf`.
 *
 * Exported for unit tests.
 */
export function parseSseChunk(
  buf: string,
  rawChunk: string,
): { buf: string; values: unknown[] } {
  buf += rawChunk;
  const values: unknown[] = [];
  // SSE events are separated by blank lines (\n\n).
  const events = buf.split("\n\n");
  // Last element is the incomplete trailing fragment (may be "").
  buf = events.pop() ?? "";
  for (const event of events) {
    for (const line of event.split("\n")) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        try {
          values.push(JSON.parse(raw));
        } catch {
          // Malformed data line; skip.
        }
      }
      // Comment lines (`:`) and other fields (retry:, event:, id:) are ignored.
    }
  }
  return { buf, values };
}

export interface CloudFollowDeps {
  // Injectable fetch for tests.
  fetchStream?: (url: string, headers: Record<string, string>) => Promise<Response>;
  emit?: (line: string) => void;
  stop?: () => boolean;
}

/**
 * Consume the /v1/projects/:slug/logs/stream SSE endpoint and print each log
 * line to stdout. Runs until the server closes the stream or stop() is true.
 *
 * Uses Node 22 global fetch + ReadableStream to read the body incrementally —
 * no EventSource (not available in Node), no extra deps.
 *
 * // ponytail: single-stream consumer; reconnect-on-drop can be added if needed.
 * The de-dup `acceptLines` safety net from the old poll loop is kept as a
 * comment reminder — SSE delivers each line exactly once per connection, so
 * de-dup is not needed here unless we add reconnect logic.
 */
export async function followCloudLogs(
  slug: string,
  deps: CloudFollowDeps = {},
): Promise<Envelope<unknown>> {
  const fetchStream = deps.fetchStream ?? (
    (url, headers) => fetch(url, { headers })
  );
  const emit = deps.emit ?? ((line) => process.stdout.write(line + "\n"));
  const stop = deps.stop ?? (() => false);

  const base = resolveBase();
  const url = `${base}/v1/projects/${encodeURIComponent(slug)}/logs/stream`;
  const headers: Record<string, string> = {
    ...authHeaders(),
    "accept": "text/event-stream",
  };

  let response: Response;
  try {
    response = await fetchStream(url, headers);
  } catch {
    return fail(
      new PodkitError(
        "E_NETWORK",
        "control-plane unreachable",
        "is it running? set PODKIT_API_URL",
      ),
    );
  }

  if (!response.ok) {
    return fail(
      new PodkitError(
        "E_NETWORK",
        "logs/stream returned HTTP " + response.status,
        "check your credentials and project slug",
      ),
    );
  }

  if (!response.body) {
    return fail(new PodkitError("E_NETWORK", "no response body"));
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (!stop()) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // Stream closed or network error; treat as clean end.
      break;
    }
    if (chunk.done) break;
    const { buf: nextBuf, values } = parseSseChunk(buf, decoder.decode(chunk.value, { stream: true }));
    buf = nextBuf;
    for (const v of values) {
      if (v && typeof v === "object" && "line" in v && typeof (v as { line: unknown }).line === "string") {
        emit((v as { line: string }).line);
      }
    }
  }

  reader.releaseLock();
  return ok({ followed: true });
}

async function previewCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [first, ...previewRest] = rest;

  // `preview list <slug>` -> show this project's preview deployments.
  if (first === "list") {
    const [slug] = previewRest;
    if (!slug) {
      return fail(
        new PodkitError("E_BAD_ARGS", "preview list requires a slug", PREVIEW_HINT),
      );
    }
    const res = await callControlPlane(
      "GET",
      `/v1/projects/${slug}/deployments`,
    );
    if (res.ok) {
      const data = res.data as any;
      const list = Array.isArray(data?.deployments) ? data.deployments : [];
      const previews = list.filter((d: any) => d?.kind === "preview");
      const rows: Record<string, string>[] = previews.map((d: any) => ({
        branchId: String(d?.branchId ?? ""),
        version: String(d?.version ?? ""),
        status: String(d?.status ?? ""),
        createdAt: String(d?.createdAt ?? ""),
      }));
      return ok(formatTable(rows));
    }
    return res;
  }

  // `preview <slug> <branchName> [--contextDir=...] [--containerPort=...]`
  const slug = first;
  const [branchName] = previewRest;
  if (!slug) {
    return fail(
      new PodkitError("E_BAD_ARGS", "preview requires a slug", PREVIEW_HINT),
    );
  }
  if (!branchName) {
    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        "preview requires a branchName",
        PREVIEW_HINT,
      ),
    );
  }
  const contextDir = parseFlag(rest, "--contextDir") ?? process.cwd();
  const appSubpath = parseFlag(rest, "--appSubpath") ?? null;
  const portStr = parseFlag(rest, "--containerPort");
  const containerPort = portStr
    ? Number(portStr)
    : Number(process.env.PODKIT_APP_PORT ?? 3000);
  if (!Number.isInteger(containerPort) || containerPort < 1) {
    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        "--containerPort must be a positive integer",
        PREVIEW_HINT,
      ),
    );
  }
  // Preview deploys upload the app source (same path as `deploy`) so they work
  // against a hosted control-plane, targeting the branch via ?branchName=.
  return await deployUpload(slug, contextDir, containerPort, appSubpath, branchName);
}

async function domainsCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [action, ...domainsRest] = rest;

  if (action === "add") {
    const [slug, domain] = domainsRest;
    if (!slug) {
      return fail(
        new PodkitError("E_BAD_ARGS", "domains add requires a slug", DOMAINS_HINT),
      );
    }
    if (!domain) {
      return fail(
        new PodkitError("E_BAD_ARGS", "domains add requires a domain", DOMAINS_HINT),
      );
    }
    return await callControlPlane("POST", `/v1/projects/${slug}/domains`, {
      domain,
    });
  }

  if (action === "list") {
    const [slug] = domainsRest;
    if (!slug) {
      return fail(
        new PodkitError("E_BAD_ARGS", "domains list requires a slug", DOMAINS_HINT),
      );
    }
    return await callControlPlane("GET", `/v1/projects/${slug}/domains`);
  }

  if (action === "rm") {
    const [slug, domain] = domainsRest;
    if (!slug) {
      return fail(
        new PodkitError("E_BAD_ARGS", "domains rm requires a slug", DOMAINS_HINT),
      );
    }
    if (!domain) {
      return fail(
        new PodkitError("E_BAD_ARGS", "domains rm requires a domain", DOMAINS_HINT),
      );
    }
    return await callControlPlane(
      "DELETE",
      `/v1/projects/${slug}/domains/${domain}`,
    );
  }

  return fail(
    new PodkitError(
      "E_BAD_ARGS",
      action ? `Unknown domains action: ${action}` : "domains requires an action",
      DOMAINS_HINT,
    ),
  );
}

// Minimal interactive yes/no prompt for destructive actions. Returns true only
// on an explicit "y"/"yes". Defaults to false (declines) on EOF/empty input, so
// piping `echo "" |` or a closed stdin is treated as "no" — fail safe.
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

async function branchesCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [action, ...branchesRest] = rest;

  if (action === "list") {
    const [slug] = branchesRest;
    if (!slug) {
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          "branches list requires a slug",
          BRANCHES_HINT,
        ),
      );
    }
    const res = await callControlPlane("GET", `/v1/projects/${slug}/branches`);
    if (res.ok) {
      const data = res.data as any;
      const list = Array.isArray(data?.branches) ? data.branches : [];
      const rows: Record<string, string>[] = list.map((b: any) => ({
        name: String(b?.name ?? ""),
        database: String(b?.database ?? ""),
        createdAt: String(b?.createdAt ?? ""),
      }));
      return ok(formatTable(rows));
    }
    return res;
  }

  if (action === "create") {
    const [slug, name] = branchesRest;
    if (!slug) {
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          "branches create requires a slug",
          BRANCHES_HINT,
        ),
      );
    }
    if (!name) {
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          "branches create requires a branch name",
          BRANCHES_HINT,
        ),
      );
    }
    const res = await callControlPlane(
      "POST",
      `/v1/projects/${slug}/branches`,
      { name },
    );
    if (res.ok) {
      const data = res.data as any;
      return ok({
        name: data?.branch?.name ?? name,
        database: data?.branch?.database ?? "",
        // One-time scoped connection string for the new branch — put it in .env.
        connectionString: data?.connectionString ?? "",
      });
    }
    return res;
  }

  if (action === "rm") {
    const [slug, name] = branchesRest;
    if (!slug) {
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          "branches rm requires a slug",
          BRANCHES_HINT,
        ),
      );
    }
    if (!name) {
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          "branches rm requires a branch name",
          BRANCHES_HINT,
        ),
      );
    }
    const confirmed = await confirm(
      `Delete branch "${name}" of project "${slug}"? This drops its database. [y/N] `,
    );
    if (!confirmed) {
      return ok({ status: "aborted" });
    }
    return await callControlPlane(
      "DELETE",
      `/v1/projects/${slug}/branches/${name}`,
    );
  }

  return fail(
    new PodkitError(
      "E_BAD_ARGS",
      action
        ? `Unknown branches action: ${action}`
        : "branches requires an action",
      BRANCHES_HINT,
    ),
  );
}

async function cronCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [action, ...cronRest] = rest;

  if (action === "add") {
    const [slug, name, schedule, path] = cronRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "cron add requires a slug", CRON_HINT));
    if (!name) return fail(new PodkitError("E_BAD_ARGS", "cron add requires a name", CRON_HINT));
    if (!schedule) return fail(new PodkitError("E_BAD_ARGS", "cron add requires a schedule", CRON_HINT));
    if (!path) return fail(new PodkitError("E_BAD_ARGS", "cron add requires a path", CRON_HINT));
    const method = parseFlag(cronRest, "--method") ?? "GET";
    if (method !== "GET" && method !== "POST") {
      return fail(new PodkitError("E_BAD_ARGS", "--method must be GET or POST", CRON_HINT));
    }
    return await callControlPlane("POST", `/v1/projects/${slug}/crons`, {
      name,
      schedule,
      path,
      method,
    });
  }

  if (action === "list") {
    const [slug] = cronRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "cron list requires a slug", CRON_HINT));
    const res = await callControlPlane("GET", `/v1/projects/${slug}/crons`);
    if (cronRest.includes("--table") && res.ok) {
      const data = res.data as { crons?: unknown };
      const list = Array.isArray(data?.crons) ? data.crons : [];
      const rows = list.map((c: Record<string, unknown>) => ({
        name: String(c?.name ?? ""),
        schedule: String(c?.schedule ?? ""),
        path: String(c?.path ?? ""),
        method: String(c?.method ?? ""),
        enabled: String(c?.enabled ?? ""),
        lastRunAt: String(c?.lastRunAt ?? ""),
      }));
      return ok(formatTable(rows));
    }
    return res;
  }

  if (action === "rm") {
    const [slug, name] = cronRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "cron rm requires a slug", CRON_HINT));
    if (!name) return fail(new PodkitError("E_BAD_ARGS", "cron rm requires a name", CRON_HINT));
    return await callControlPlane("DELETE", `/v1/projects/${slug}/crons/${name}`);
  }

  return fail(
    new PodkitError(
      "E_BAD_ARGS",
      action ? `Unknown cron action: ${action}` : "cron requires an action",
      CRON_HINT,
    ),
  );
}

async function envCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [action, ...envRest] = rest;

  if (action === "set") {
    const [slug, kv] = envRest;
    if (!slug) {
      return fail(new PodkitError("E_BAD_ARGS", "env set requires a slug", ENV_HINT));
    }
    if (!kv || !kv.includes("=")) {
      return fail(
        new PodkitError("E_BAD_ARGS", "env set requires KEY=VALUE", ENV_HINT),
      );
    }
    const eq = kv.indexOf("=");
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    const sensitive = envRest.includes("--sensitive");
    return await callControlPlane("POST", `/v1/projects/${slug}/env`, {
      key,
      value,
      sensitive,
    });
  }

  if (action === "list") {
    const [slug] = envRest;
    if (!slug) {
      return fail(new PodkitError("E_BAD_ARGS", "env list requires a slug", ENV_HINT));
    }
    return await callControlPlane("GET", `/v1/projects/${slug}/env`);
  }

  if (action === "rm") {
    const [slug, key] = envRest;
    if (!slug) {
      return fail(new PodkitError("E_BAD_ARGS", "env rm requires a slug", ENV_HINT));
    }
    if (!key) {
      return fail(new PodkitError("E_BAD_ARGS", "env rm requires a key", ENV_HINT));
    }
    return await callControlPlane("DELETE", `/v1/projects/${slug}/env/${key}`);
  }

  return fail(
    new PodkitError(
      "E_BAD_ARGS",
      action ? `Unknown env action: ${action}` : "env requires an action",
      ENV_HINT,
    ),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// `members <slug> [--table]` — list project members
async function membersCommand(
  slug: string,
  wantsTable: boolean,
): Promise<Envelope<unknown>> {
  const res = await callControlPlane(
    "GET",
    `/v1/projects/${encodeURIComponent(slug)}/members`,
  );
  if (res.ok && wantsTable) {
    const data = res.data as { members?: unknown[] };
    const list = Array.isArray(data?.members) ? data.members : [];
    const rows: Record<string, string>[] = list.map((m: unknown) => {
      const member = m as { accountId?: unknown; role?: unknown; createdAt?: unknown };
      return {
        accountId: String(member?.accountId ?? ""),
        role: String(member?.role ?? ""),
        createdAt: String(member?.createdAt ?? ""),
      };
    });
    return ok(formatTable(rows));
  }
  return res;
}

// `invite <slug> <email> [role]` | `invite accept <token>` | `member rm <slug> <accountId>`
async function inviteCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [first, ...inviteRest] = rest;

  if (first === "accept") {
    const [token] = inviteRest;
    if (!token) {
      return fail(
        new PodkitError("E_BAD_ARGS", "invite accept requires a token", INVITE_HINT),
      );
    }
    return await callControlPlane(
      "POST",
      `/v1/invites/${encodeURIComponent(token)}/accept`,
    );
  }

  // `invite <slug> <email> [role]`
  const slug = first;
  const [email, role] = inviteRest;
  if (!slug) {
    return fail(
      new PodkitError("E_BAD_ARGS", "invite requires a slug", INVITE_HINT),
    );
  }
  if (!email) {
    return fail(
      new PodkitError("E_BAD_ARGS", "invite requires an email", INVITE_HINT),
    );
  }
  const body: { email: string; role?: string } = { email };
  if (role) body.role = role;
  return await callControlPlane(
    "POST",
    `/v1/projects/${encodeURIComponent(slug)}/invites`,
    body,
  );
}

async function memberRmCommand(rest: string[]): Promise<Envelope<unknown>> {
  const [slug, accountId] = rest;
  if (!slug) {
    return fail(
      new PodkitError("E_BAD_ARGS", "member rm requires a slug", MEMBERS_HINT),
    );
  }
  if (!accountId) {
    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        "member rm requires an accountId",
        MEMBERS_HINT,
      ),
    );
  }
  return await callControlPlane(
    "DELETE",
    `/v1/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(accountId)}`,
  );
}

async function login(rest: string[]): Promise<Envelope<unknown>> {
  let base = resolveBase();
  const urlIdx = rest.indexOf("--url");
  if (urlIdx !== -1) {
    const value = rest[urlIdx + 1];
    if (!value) {
      return fail(new PodkitError("E_BAD_ARGS", "--url requires a value", AVAILABLE));
    }
    base = value;
  }

  let startRes: Response;
  try {
    startRes = await fetch(base + "/v1/auth/cli/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  } catch {
    return fail(
      new PodkitError(
        "E_NETWORK",
        "control-plane unreachable",
        "is it running? set PODKIT_API_URL",
      ),
    );
  }

  const start = (await startRes.json()) as StartResponse;

  console.error(
    `Your device code: ${start.userCode}  —  open ${start.verifyUrl} and enter it.`,
  );
  openInBrowser(start.verifyUrl);

  const pollInterval = start.pollInterval ?? 1000;
  const maxAttempts = 120;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(pollInterval);

    let pollRes: Response;
    try {
      pollRes = await fetch(base + "/v1/auth/cli/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      });
    } catch {
      return fail(
        new PodkitError(
          "E_NETWORK",
          "control-plane unreachable",
          "is it running? set PODKIT_API_URL",
        ),
      );
    }

    const poll = (await pollRes.json()) as PollResponse;

    if (poll.status === "approved" && poll.token) {
      writeAuth({ url: base, token: poll.token });
      return ok({ status: "logged in" });
    }

    if (poll.status === "expired") {
      return fail(new PodkitError("E_BAD_ARGS", "login code expired, try again"));
    }
  }

  return fail(new PodkitError("E_BAD_ARGS", "login timed out"));
}

async function blobCommand(rest: string[], wantsTable: boolean): Promise<Envelope<unknown>> {
  const [action, ...blobRest] = rest;

  if (action === "put") {
    const [slug, key, filePath] = blobRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "blob put requires a slug", BLOB_HINT));
    if (!key) return fail(new PodkitError("E_BAD_ARGS", "blob put requires a key", BLOB_HINT));
    if (!filePath) return fail(new PodkitError("E_BAD_ARGS", "blob put requires a file path", BLOB_HINT));
    let fileData: Buffer;
    try {
      fileData = readFileSync(filePath);
    } catch {
      return fail(new PodkitError("E_BAD_ARGS", "could not read file: " + filePath, BLOB_HINT));
    }
    // Infer a rough content-type from extension; no dep needed.
    // ponytail: fixed map; upgrade to mime-types lib or --content-type flag for full coverage.
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const contentTypeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      txt: "text/plain",
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      json: "application/json",
      wasm: "application/wasm",
    };
    const contentType = contentTypeMap[ext] ?? "application/octet-stream";
    const dataBase64 = fileData.toString("base64");
    return callControlPlane(
      "PUT",
      `/v1/projects/${encodeURIComponent(slug)}/blobs/${encodeURIComponent(key)}`,
      { contentType, dataBase64 },
    );
  }

  if (action === "get") {
    const [slug, key, outFile] = blobRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "blob get requires a slug", BLOB_HINT));
    if (!key) return fail(new PodkitError("E_BAD_ARGS", "blob get requires a key", BLOB_HINT));
    // Get a signed URL for this blob, then fetch the raw bytes.
    const urlRes = await callControlPlane(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/blobs/${encodeURIComponent(key)}/url`,
    );
    if (!urlRes.ok) return urlRes;
    const blobUrl = (urlRes.data as { url?: string })?.url;
    if (!blobUrl) return fail(new PodkitError("E_BAD_STATE", "no url in response"));
    const base = resolveBase();
    let fetchRes: Response;
    try {
      fetchRes = await fetch(base + blobUrl);
    } catch {
      return fail(new PodkitError("E_NETWORK", "could not fetch blob bytes"));
    }
    if (!fetchRes.ok) {
      return fail(new PodkitError("E_BAD_STATE", "blob download failed: HTTP " + fetchRes.status));
    }
    const bytes = Buffer.from(await fetchRes.arrayBuffer());
    if (outFile) {
      try {
        writeFileSync(outFile, bytes);
      } catch {
        return fail(new PodkitError("E_BAD_STATE", "could not write to: " + outFile));
      }
      return ok({ saved: outFile, size: bytes.length });
    }
    // Print to stdout as base64 when no outFile given (safe for any binary content).
    process.stdout.write(bytes.toString("base64") + "\n");
    return ok({ size: bytes.length });
  }

  if (action === "ls") {
    const [slug] = blobRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "blob ls requires a slug", BLOB_HINT));
    const res = await callControlPlane("GET", `/v1/projects/${encodeURIComponent(slug)}/blobs`);
    if (res.ok && wantsTable) {
      const data = res.data as { blobs?: unknown[] };
      const list = Array.isArray(data?.blobs) ? data.blobs : [];
      const rows: Record<string, string>[] = list.map((b: unknown) => {
        const blob = b as { key?: unknown; contentType?: unknown; size?: unknown; createdAt?: unknown };
        return {
          key: String(blob?.key ?? ""),
          contentType: String(blob?.contentType ?? ""),
          size: String(blob?.size ?? ""),
          createdAt: String(blob?.createdAt ?? ""),
        };
      });
      return ok(formatTable(rows));
    }
    return res;
  }

  if (action === "rm") {
    const [slug, key] = blobRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "blob rm requires a slug", BLOB_HINT));
    if (!key) return fail(new PodkitError("E_BAD_ARGS", "blob rm requires a key", BLOB_HINT));
    return callControlPlane(
      "DELETE",
      `/v1/projects/${encodeURIComponent(slug)}/blobs/${encodeURIComponent(key)}`,
    );
  }

  if (action === "url") {
    const [slug, key] = blobRest;
    if (!slug) return fail(new PodkitError("E_BAD_ARGS", "blob url requires a slug", BLOB_HINT));
    if (!key) return fail(new PodkitError("E_BAD_ARGS", "blob url requires a key", BLOB_HINT));
    const expIdx = blobRest.indexOf("--exp");
    const expSec = expIdx !== -1 ? blobRest[expIdx + 1] : null;
    const qs = expSec ? `?expSec=${encodeURIComponent(expSec)}` : "";
    return callControlPlane(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/blobs/${encodeURIComponent(key)}/url${qs}`,
    );
  }

  return fail(
    new PodkitError(
      "E_BAD_ARGS",
      action ? `Unknown blob action: ${action}` : "blob requires an action",
      BLOB_HINT,
    ),
  );
}

export async function cloudCommand(args: string[]): Promise<Envelope<unknown>> {
  const [subcommand, ...args1] = args;
  const wantsTable = args1.includes("--table");
  const rest = args1.filter((arg) => arg !== "--table");

  try {
    if (subcommand === "projects" || subcommand === "list") {
      const res = await callControlPlane("GET", "/v1/projects");
      if (wantsTable && res.ok) {
        const data = res.data as any;
        const list = Array.isArray(data?.projects)
          ? data.projects
          : Array.isArray(data)
            ? data
            : [];
        const rows: Record<string, string>[] = list.map((p: any) => ({
          slug: String(p?.slug ?? ""),
          url: String(p?.url ?? ""),
        }));
        return ok(formatTable(rows));
      }
      return res;
    }

    if (subcommand === "create") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "create requires a slug", AVAILABLE),
        );
      }
      return await callControlPlane("POST", "/v1/projects", {
        slug,
        owner: process.env.USER ?? "cli",
      });
    }

    if (subcommand === "deploy") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "deploy requires a slug", DEPLOY_HINT),
        );
      }
      // Upload-based deploy: tar the context dir and stream it to the
      // control-plane (it extracts + builds). --contextDir defaults to cwd;
      // --appSubpath is forwarded as a query param (e.g. apps/myapp).
      const contextDir = parseFlag(rest, "--contextDir") ?? process.cwd();
      const portStr = parseFlag(rest, "--containerPort");
      const containerPort = portStr
        ? Number(portStr)
        : Number(process.env.PODKIT_APP_PORT ?? 3000);
      if (!Number.isInteger(containerPort) || containerPort < 1) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--containerPort must be a positive integer",
            DEPLOY_HINT,
          ),
        );
      }
      const appSubpath = parseFlag(rest, "--appSubpath");
      return await deployUpload(slug, contextDir, containerPort, appSubpath);
    }

    if (subcommand === "url") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "url requires a slug", AVAILABLE),
        );
      }
      return await callControlPlane("GET", `/v1/projects/${slug}`);
    }

    if (subcommand === "open") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "open requires a slug", AVAILABLE),
        );
      }
      const proj = await callControlPlane(
        "GET",
        `/v1/projects/${encodeURIComponent(slug)}`,
      );
      if (!proj.ok) return proj;
      const url = (proj.data as any)?.url;
      if (!url) {
        return fail(
          new PodkitError("E_BAD_STATE", "project has no URL", "deploy first"),
        );
      }
      openInBrowser(url);
      return ok({ status: "opened", url });
    }

    if (subcommand === "deployments") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "deployments requires a slug", AVAILABLE),
        );
      }
      return await callControlPlane("GET", `/v1/projects/${slug}/deployments`);
    }

    if (subcommand === "rollback") {
      const [slug, deploymentId] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "rollback requires a slug", AVAILABLE),
        );
      }
      if (!deploymentId) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "rollback requires a deploymentId",
            "list ids with: podkit cloud deployments <slug>",
          ),
        );
      }
      return await callControlPlane("POST", `/v1/projects/${slug}/rollback`, {
        deploymentId,
      });
    }

    if (subcommand === "logs") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "logs requires a slug", AVAILABLE),
        );
      }
      if (rest.includes("--follow") || rest.includes("-f")) {
        return await followCloudLogs(slug);
      }
      return await callControlPlane("GET", `/v1/projects/${slug}/logs`);
    }

    if (subcommand === "env") {
      return await envCommand(rest);
    }

    if (subcommand === "domains") {
      return await domainsCommand(rest);
    }

    if (subcommand === "branches") {
      return await branchesCommand(rest);
    }

    if (subcommand === "cron") {
      return await cronCommand(rest);
    }

    if (subcommand === "preview") {
      return await previewCommand(rest);
    }

    if (subcommand === "blob") {
      return await blobCommand(rest, wantsTable);
    }

    if (subcommand === "members") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "members requires a slug", MEMBERS_HINT),
        );
      }
      return await membersCommand(slug, wantsTable);
    }

    if (subcommand === "invite") {
      return await inviteCommand(rest);
    }

    if (subcommand === "member") {
      const [action, ...memberRest] = rest;
      if (action === "rm") {
        return await memberRmCommand(memberRest);
      }
      return fail(
        new PodkitError(
          "E_BAD_ARGS",
          action ? `Unknown member action: ${action}` : "member requires an action (rm)",
          MEMBERS_HINT,
        ),
      );
    }

    if (subcommand === "login") {
      return await login(rest);
    }

    if (subcommand === "logout") {
      clearAuth();
      return ok({ status: "logged out" });
    }

    if (subcommand === "whoami") {
      return await callControlPlane("GET", "/v1/auth/me");
    }

    if (subcommand === "status") {
      const [slug] = rest;
      if (!slug) {
        return fail(
          new PodkitError("E_BAD_ARGS", "status requires a slug", AVAILABLE),
        );
      }
      const [proj, depls, env, domains] = await Promise.all([
        callControlPlane("GET", `/v1/projects/${slug}`),
        callControlPlane("GET", `/v1/projects/${slug}/deployments`),
        callControlPlane("GET", `/v1/projects/${slug}/env`),
        callControlPlane("GET", `/v1/projects/${slug}/domains`),
      ]);
      if (!proj.ok) return proj;
      const pd = proj.data as any;
      const dd = depls.ok ? (depls.data as any) : null;
      const deployments = Array.isArray(dd?.deployments)
        ? dd.deployments
        : Array.isArray(dd)
          ? dd
          : null;
      const ed = env.ok ? (env.data as any) : null;
      const od = domains.ok ? (domains.data as any) : null;
      const latestDeployment =
        deployments && deployments.length > 0
          ? deployments[deployments.length - 1]
          : null;
      const envCount = Array.isArray(ed?.env)
        ? ed.env.length
        : Array.isArray(ed)
          ? ed.length
          : 0;
      const domainCount = Array.isArray(od?.domains)
        ? od.domains.length
        : Array.isArray(od)
          ? od.length
          : 0;
      if (wantsTable) {
        const rows: Record<string, string>[] = [
          {
            slug,
            url: String(pd?.url ?? ""),
            version: String(latestDeployment?.version ?? latestDeployment?.id ?? ""),
            env: String(envCount),
            domains: String(domainCount),
          },
        ];
        return ok(formatTable(rows));
      }
      return ok({
        slug,
        url: pd?.url ?? null,
        latestDeployment,
        envCount,
        domainCount,
      });
    }

    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        subcommand
          ? `Unknown cloud subcommand: ${subcommand}`
          : "No cloud subcommand given",
        AVAILABLE,
      ),
    );
  } catch (err) {
    return fail(err);
  }
}
