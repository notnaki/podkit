import { useState } from "react";
import { api, getToken } from "../api/client.ts";
import type { Project } from "../api/client.ts";
import { useApi, relativeTime } from "../lib/useApi.ts";

function statusClass(status?: string | null) {
  if (status === "running" || status === "ready") return "status status-ready";
  if (status === "building") return "status status-building";
  if (status) return "status status-error";
  return "status status-none";
}

export function Projects() {
  const projects = useApi(() => api.listProjects(), []);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const list = (projects.data?.projects ?? []).filter((p) =>
    p.slug.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <main className="wrap rise">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Every app deployed to your podkit cloud — each gets a container, a routed URL, and its own Postgres.</p>
        </div>
        <button className="btn btn-invert" onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "Add New…"}
        </button>
      </div>

      {creating && <CreateProject onDone={() => { setCreating(false); projects.reload(); }} />}

      <div className="search" style={{ margin: "var(--space-lg) 0" }}>
        <input className="input" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {projects.loading ? (
        <div className="state">Loading projects…</div>
      ) : projects.error ? (
        <div className="state"><strong>{projects.error.code}</strong><span>{projects.error.message}</span></div>
      ) : list.length === 0 ? (
        <div className="state">
          <strong>{q ? "No matches" : "No projects yet"}</strong>
          <span>{q ? "Try a different search." : "Create your first project to deploy an app and provision a database."}</span>
        </div>
      ) : (
        <div className="project-grid">
          {list.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}
    </main>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const deployed = p.lastDeployedAt ? relativeTime(new Date(p.lastDeployedAt).getTime(), Date.now()) : null;
  return (
    <a className="project-card" href={`#/p/${encodeURIComponent(p.slug)}`}>
      <div className="pc-head">
        <span className="avatar">{p.slug.slice(0, 1).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div className="pc-name">{p.slug}</div>
          <div className="pc-domain mono">{p.url ? p.url.replace(/^https?:\/\//, "") : "not deployed"}</div>
        </div>
      </div>
      <div className="pc-foot">
        <span className={statusClass(p.status)}>
          <span className="dot" />
          {p.status === "running" ? "Ready" : p.version ? p.status : "No deployment"}
        </span>
        {p.version && <span className="mono faint" style={{ fontSize: "var(--t-xs)" }}>{p.version}</span>}
        {deployed && <span className="faint mono" style={{ fontSize: "var(--t-xs)" }}>{deployed}</span>}
      </div>
    </a>
  );
}

// Subtle, on-brand copy button for the one-time connection string.
function CopyConn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable — fail quietly.
    }
  }
  return <button className="btn btn-ghost btn-sm" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>;
}

function CreateProject({ onDone }: { onDone: () => void }) {
  const [slug, setSlug] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ connectionString?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = getToken() !== "";

  async function create() {
    setBusy(true); setErr(null);
    const res = await api.createProject(slug.trim(), owner.trim() || "me");
    setBusy(false);
    if (res.ok) setResult({ connectionString: res.data.connectionString });
    else setErr(`${res.error.code}: ${res.error.message}`);
  }

  if (result) {
    return (
      <div className="panel rise">
        <div className="panel-head"><h3>Project created</h3><span className="status status-ready"><span className="dot" />provisioned</span></div>
        <div className="panel-body stack">
          <div className="field">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <label>Database connection string <span className="faint">— shown once, store it now</span></label>
              {result.connectionString && <CopyConn value={result.connectionString} />}
            </div>
            <div className="code" style={{ wordBreak: "break-all" }}>{result.connectionString ?? "(connection available via the API)"}</div>
          </div>
          <div className="row">
            <a className="btn btn-invert" href={`#/p/${encodeURIComponent(slug.trim())}`} onClick={onDone}>Open project →</a>
            <button className="btn btn-ghost" onClick={onDone}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel rise">
      <div className="panel-head"><h3>New project</h3></div>
      <div className="panel-body stack">
        {!hasKey && <span className="status status-building"><span className="dot" />sign in to create projects</span>}
        <div className="grid-2">
          <div className="field"><label>Slug</label><input className="input mono" placeholder="my-app" value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
          <div className="field"><label>Owner</label><input className="input" placeholder="me" value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
        </div>
        {err && <span className="status status-error"><span className="dot" />{err}</span>}
        <div className="row">
          <button className="btn btn-invert" disabled={!hasKey || busy || !slug.trim()} onClick={create}>{busy ? "Creating…" : "Create project"}</button>
        </div>
      </div>
    </div>
  );
}
