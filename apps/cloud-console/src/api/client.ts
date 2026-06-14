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
  // Present only for preview deployments (FK to the branch); null for prod.
  branchId?: string | null;
  createdAt: string | null;
  active: boolean;
}
export interface PreviewDeployResult {
  version: string;
  hostPort: number;
  branchName: string;
  url: string;
}
export interface ProjectDetail { project: Project; latest: Deployment | null; url: string | null }
export interface CreatedProject { project: Project; database?: string; connectionString?: string }
export interface EnvVar { key: string; sensitive: boolean; value: string | null }
export interface Domain { domain: string }
export interface Metrics {
  requests: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  avgLatencyMs: number;
  lastSeen: number | null;
}
export interface QueryResult { rows: Record<string, unknown>[]; rowCount: number }
export interface Branch { id: string; name: string; database: string; createdAt: string }
export interface CreatedBranch {
  branch: { id: string; name: string; database: string };
  connectionString: string;
}

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
  getLogs: (slug: string, opts?: { limit?: number; since?: string }) => {
    const qs: string[] = [];
    if (opts?.limit !== undefined) qs.push(`limit=${encodeURIComponent(String(opts.limit))}`);
    if (opts?.since !== undefined && opts.since !== "") qs.push(`since=${encodeURIComponent(opts.since)}`);
    const suffix = qs.length > 0 ? `?${qs.join("&")}` : "";
    return call<{ deploymentId: string | null; version: string | null; logs: string }>(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/logs${suffix}`,
    );
  },
  getMetrics: (slug: string) =>
    call<Metrics>("GET", `/v1/projects/${encodeURIComponent(slug)}/metrics`),
  runQuery: (slug: string, sql: string, params?: (string | number)[]) =>
    call<QueryResult>(
      "POST",
      `/v1/projects/${encodeURIComponent(slug)}/db/query`,
      params !== undefined ? { sql, params } : { sql },
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
  listBranches: (slug: string) =>
    call<{ branches: Branch[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/branches`,
    ),
  createBranch: (slug: string, name: string) =>
    call<CreatedBranch>(
      "POST",
      `/v1/projects/${encodeURIComponent(slug)}/branches`,
      { name },
    ),
  deleteBranch: (slug: string, name: string) =>
    call<{ deleted: string }>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(slug)}/branches/${encodeURIComponent(name)}`,
    ),
  // Deploy a branch as an isolated preview (routes under <slug>--<branch>).
  deployPreview: (
    slug: string,
    branchName: string,
    contextDir: string,
    containerPort: number,
  ) =>
    call<PreviewDeployResult>(
      "POST",
      `/v1/projects/${encodeURIComponent(slug)}/deploy-branch`,
      { branchName, contextDir, containerPort },
    ),
  // List a project's deployments, filtered to preview-kind rows only.
  listPreviewDeployments: async (slug: string) => {
    const res = await call<{ deployments: DeploymentHistoryItem[] }>(
      "GET",
      `/v1/projects/${encodeURIComponent(slug)}/deployments`,
    );
    if (!res.ok) return res;
    return {
      ok: true as const,
      data: {
        deployments: res.data.deployments.filter((d) => d.kind === "preview"),
      },
    };
  },
  // Tear down an active branch preview (stops its container, clears the route).
  deletePreview: (slug: string, branchName: string) =>
    call<{ stopped: string }>(
      "DELETE",
      `/v1/projects/${encodeURIComponent(slug)}/preview/${encodeURIComponent(branchName)}`,
    ),
};
