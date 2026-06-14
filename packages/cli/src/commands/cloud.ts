import { spawn } from "node:child_process";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";
import { readAuth, writeAuth, clearAuth } from "../auth-store.ts";

type Method = "GET" | "POST";

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

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(command, [url], {
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
  "Available: projects, create <slug>, deploy <slug>, url <slug>, login [--url <url>], logout, whoami";

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
  const [subcommand, ...rest] = args;

  try {
    if (subcommand === "projects") {
      return await callControlPlane("GET", "/v1/projects");
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
          new PodkitError("E_BAD_ARGS", "deploy requires a slug", AVAILABLE),
        );
      }
      return await callControlPlane("POST", `/v1/projects/${slug}/deploy`, {
        contextDir: process.cwd(),
        containerPort: Number(process.env.PODKIT_APP_PORT ?? 3000),
      });
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
