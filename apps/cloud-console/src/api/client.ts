// Client for the podkit control-plane (@podkit/cloud-host). Base URL + API key
// are persisted locally; mutating calls send x-podkit-key.

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; hint?: string } };

const URL_KEY = "podkit.cloud.apiUrl";
const KEY_KEY = "podkit.cloud.apiKey";

export function getConfig(): { url: string; key: string } {
  return {
    url: localStorage.getItem(URL_KEY) ?? "http://localhost:8080",
    key: localStorage.getItem(KEY_KEY) ?? "",
  };
}
export function setConfig(url: string, key: string): void {
  localStorage.setItem(URL_KEY, url);
  localStorage.setItem(KEY_KEY, key);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const { url, key } = getConfig();
  try {
    const res = await fetch(url.replace(/\/$/, "") + path, {
      method,
      headers: { "content-type": "application/json", ...(key ? { "x-podkit-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Envelope<T>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "E_NETWORK",
        message: err instanceof Error ? err.message : "request failed",
        hint: "Is the control-plane running? Check the API URL (Connect).",
      },
    };
  }
}

export interface Project {
  id: string;
  slug: string;
  owner: string;
  // enriched by the control-plane's list endpoint when available
  url?: string | null;
  version?: string | null;
  status?: string | null;
}
export interface Deployment { id?: string; version: string; hostPort?: number; status?: string }
export interface ProjectDetail { project: Project; latest: Deployment | null; url: string | null }
export interface CreatedProject { project: Project; database?: string; connectionString?: string }

export const api = {
  health: () => call<{ status: string }>("GET", "/v1/health"),
  listProjects: () => call<{ projects: Project[] }>("GET", "/v1/projects"),
  createProject: (slug: string, owner: string) =>
    call<CreatedProject>("POST", "/v1/projects", { slug, owner }),
  getProject: (slug: string) =>
    call<ProjectDetail>("GET", `/v1/projects/${encodeURIComponent(slug)}`),
  deployProject: (slug: string, contextDir: string, containerPort: number) =>
    call<{ version: string; hostPort: number; url: string }>(
      "POST",
      `/v1/projects/${encodeURIComponent(slug)}/deploy`,
      { contextDir, containerPort },
    ),
};
