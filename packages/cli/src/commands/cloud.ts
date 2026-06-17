import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";
import { readAuth, writeAuth, clearAuth } from "../auth-store.ts";
import { acceptLines, initLineTailState, type LineTailState } from "./tail.ts";

type Method = "GET" | "POST" | "DELETE";

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
  "Available: projects, create <slug>, deploy <slug> (one-click; flags optional: [--contextDir=<dir>] [--containerPort=3000] [--appSubpath=<path>]), url <slug>, open <slug>, status <slug>, deployments <slug>, rollback <slug> <deploymentId>, logs <slug> [--follow|-f], env, domains, branches, preview <slug> <branchName>, login [--url <url>], logout, whoami";

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

// Parse a `--flag=value` style option out of an argv slice. Returns null when
// the flag is absent or has no value.
function parseFlag(args: string[], flag: string): string | null {
  const prefix = flag + "=";
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

// Fetches one batch of container logs for `slug` since an optional ISO cursor.
// Returns the raw log blob (text). Injectable for tests via the deps param.
export type CloudLogFetch = (slug: string, since: string | undefined) => Promise<string>;

const fetchCloudLogs: CloudLogFetch = async (slug, since) => {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const res = await callControlPlane("GET", `/v1/projects/${slug}/logs${qs}`);
  if (!res.ok) return "";
  const data = res.data as { logs?: unknown };
  return typeof data.logs === "string" ? data.logs : "";
};

export interface CloudFollowDeps {
  fetch?: CloudLogFetch;
  emit?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  intervalMs?: number;
  stop?: () => boolean;
  state?: LineTailState;
}

// Polls the cloud logs endpoint with a moving ISO `?since` cursor and prints
// only new lines, de-duping the inclusive (second-granularity) overlap via
// acceptLines. Runs until stop() is true (Ctrl-C kills the process in the CLI).
//
// ponytail: client-side polling tail — NOT server push/SSE/websocket. The
// `?since` cursor is advanced to the request time each poll; docker's
// second-granularity `--since` means the boundary second re-appears, which the
// line de-dup window absorbs. Upgrade path: a streaming logs endpoint.
export async function followCloudLogs(
  slug: string,
  deps: CloudFollowDeps = {},
): Promise<Envelope<unknown>> {
  const fetchLogs = deps.fetch ?? fetchCloudLogs;
  const emit = deps.emit ?? ((line) => process.stdout.write(line + "\n"));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const intervalMs = deps.intervalMs ?? 1500;
  const stop = deps.stop ?? (() => false);
  const state = deps.state ?? initLineTailState();

  let since: string | undefined;
  while (!stop()) {
    const requestedAt = now();
    const blob = await fetchLogs(slug, since);
    for (const line of acceptLines(state, blob)) emit(line);
    // Advance the cursor to this request's time so the next poll only asks for
    // newer lines; the de-dup window covers the inclusive-second overlap.
    since = requestedAt.toISOString();
    if (stop()) break;
    await sleep(intervalMs);
  }
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

    if (subcommand === "preview") {
      return await previewCommand(rest);
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
