// Client for the podkit control-plane (@podkit/cloud-host). Base URL + session
// token are persisted locally; authenticated calls send Authorization: Bearer.

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; hint?: string } };

const URL_KEY = "podkit.cloud.apiUrl";
const TOKEN_KEY = "podkit.cloud.token";

export function getApiUrl(): string {
  return localStorage.getItem(URL_KEY) ?? "";
}
export function setApiUrl(url: string): void {
  localStorage.setItem(URL_KEY, url);
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
  const base = getApiUrl();
  const token = getToken();
  // When base is "" (same-origin), use a plain relative path; otherwise strip trailing slash.
  const href = base === "" ? path : base.replace(/\/$/, "") + path;
  try {
    const res = await fetch(href, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
        hint: "Is the control-plane running? Check the API URL (Connect).",
      },
    };
  }
}

export interface Account {
  id: string;
  email: string;
}
export interface AuthResult {
  token: string;
  account: Account;
}

export interface Project {
  id: string;
  slug: string;
  owner: string;
  // enriched by the control-plane's list endpoint when available
  url?: string | null;
  version?: string | null;
  status?: string | null;
  lastDeployedAt?: string | null;
}
export interface Deployment { id?: string; version: string; hostPort?: number; status?: string }
export interface DeploymentHistoryItem {
  id: string;
  version: string;
  status: string | null;
  kind: string | null;
  createdAt: string | null;
  active: boolean;
}
export interface ProjectDetail { project: Project; latest: Deployment | null; url: string | null }
export interface CreatedProject { project: Project; database?: string; connectionString?: string }
export interface EnvVar { key: string; sensitive: boolean; value: string | null }
export interface Domain { domain: string }

export const api = {
  health: () => call<{ status: string }>("GET", "/v1/health"),
  signup: (email: string, password: string) =>
    call<AuthResult>("POST", "/v1/auth/signup", { email, password }),
  login: (email: string, password: string) =>
    call<AuthResult>("POST", "/v1/auth/login", { email, password }),
  me: () => call<{ account: Account }>("GET", "/v1/auth/me"),
  cliApprove: (userCode: string) =>
    call<unknown>("POST", "/v1/auth/cli/approve", { userCode }),
  listProjects: () => call<{ projects: Project[] }>("GET", "/v1/projects"),
  createProject: (slug: string, owner: string) =>
    call<CreatedProject>("POST", "/v1/projects", { slug, owner }),
  getProject: (slug: string) =>
    call<ProjectDetail>("GET", `/v1/projects/${encodeURIComponent(slug)}`),
  deleteProject: (slug: string) =>
    call<{ deleted: string }>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(slug)}`,
    ),
  listDeployments: (slug: string) =>
    call<{ deployments: DeploymentHistoryItem[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/deployments`,
    ),
  rollback: (slug: string, deploymentId: string) =>
    call<{ version: string; hostPort: number; url: string; rolledBackTo: string }>(
      "POST",
      `/v1/projects/${encodeURIComponent(slug)}/rollback`,
      { deploymentId },
    ),
  getLogs: (slug: string) =>
    call<{ deploymentId: string | null; version: string | null; logs: string }>(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/logs`,
    ),
  deployProject: (slug: string, contextDir: string, containerPort: number) =>
    call<{ version: string; hostPort: number; url: string }>(
      "POST",
      `/v1/projects/${encodeURIComponent(slug)}/deploy`,
      { contextDir, containerPort },
    ),
  listEnv: (slug: string) =>
    call<{ env: EnvVar[] }>("GET", `/v1/projects/${encodeURIComponent(slug)}/env`),
  setEnv: (slug: string, key: string, value: string, sensitive: boolean) =>
    call<unknown>("POST", `/v1/projects/${encodeURIComponent(slug)}/env`, { key, value, sensitive }),
  deleteEnv: (slug: string, key: string) =>
    call<unknown>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(slug)}/env/${encodeURIComponent(key)}`,
    ),
  listDomains: (slug: string) =>
    call<{ domains: Domain[] }>("GET", `/v1/projects/${encodeURIComponent(slug)}/domains`),
  addDomain: (slug: string, domain: string) =>
    call<unknown>("POST", `/v1/projects/${encodeURIComponent(slug)}/domains`, { domain }),
  deleteDomain: (slug: string, domain: string) =>
    call<unknown>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(slug)}/domains/${encodeURIComponent(domain)}`,
    ),
};
