// Typed client for the podkit control-plane API. The dashboard is one client of
// that API (the CLI is the other). Base URL + API key are user-configurable and
// persisted locally; guarded (mutating) calls send the x-podkit-key header.

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; hint?: string } };

const BASE_KEY = "podkit.apiUrl";
const KEY_KEY = "podkit.apiKey";

export function getConfig(): { url: string; key: string } {
  return {
    url: localStorage.getItem(BASE_KEY) ?? "http://localhost:8787",
    key: localStorage.getItem(KEY_KEY) ?? "",
  };
}

export function setConfig(url: string, key: string): void {
  localStorage.setItem(BASE_KEY, url);
  localStorage.setItem(KEY_KEY, key);
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<Envelope<T>> {
  const { url, key } = getConfig();
  try {
    const res = await fetch(url.replace(/\/$/, "") + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-podkit-key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Envelope<T>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "E_NETWORK",
        message: err instanceof Error ? err.message : "request failed",
        hint: "Is the control-plane running? Check the API URL in settings.",
      },
    };
  }
}

export interface Route { pattern: string; kind: string; file: string; params: string[] }
export interface ProjectDescription { routes: Route[]; hasDb: boolean; hasAuth: boolean }
export interface Doc { topic: string; title: string; content: string }
export interface LogEvent {
  ts: number; kind: string; level?: string; message?: string;
  route?: string; requestId?: string; identity?: string; props?: Record<string, unknown>;
}

export const api = {
  health: () => call<{ status: string }>("GET", "/v1/health"),
  project: () => call<ProjectDescription>("GET", "/v1/project"),
  docs: () => call<{ topics: string[] }>("GET", "/v1/docs"),
  doc: (topic: string) => call<Doc>("GET", `/v1/docs/${encodeURIComponent(topic)}`),
  deployments: () => call<{ versions: string[]; current: string | null }>("GET", "/v1/deployments"),
  logs: () => call<{ events: LogEvent[] }>("GET", "/v1/logs"),
  analytics: () => call<{ counts: Record<string, number> }>("GET", "/v1/analytics"),
  deploy: () => call<{ versionId: string; deployId?: string; current: string | null }>("POST", "/v1/deploy", {}),
  rollback: () => call<{ from: string | null; to: string }>("POST", "/v1/rollback", {}),
  authToken: (userId: string, scopes: string[]) =>
    call<{ token: string }>("POST", "/v1/auth/token", { userId, scopes }),
};
