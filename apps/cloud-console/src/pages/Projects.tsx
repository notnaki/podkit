import { useState } from "react";
import { api, getToken } from "../api/client.ts";
import type { Project } from "../api/client.ts";
import { useApi, relativeTime, useLiveStatus, resolveStatus } from "../lib/useApi.ts";

export function Projects() {
  // Each card subscribes to live status over SSE (see ProjectCard). This poll is
  // the data fallback: it refreshes url/version/lastDeployed and covers cards
  // whose SSE stream is down. 1.5s < the ~2s wake window, so a sample always
  // lands inside it.
  // ponytail: EventSource per card for live status, list poll as fallback.
  const projects = useApi(() => api.listProjects(), [], 1500);
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
          <p>Every app deployed to your podkit cloud. Each gets a container, a routed URL, and its own Postgres.</p>
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
        <div className="project-grid" aria-busy="true" aria-label="Loading projects">
          {Array.from({ length: 6 }).map((_, i) => <ProjectCardSkeleton key={i} />)}
        </div>
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

// Calm loading: a card-shaped skeleton that matches ProjectCard's layout.
function ProjectCardSkeleton() {
  return (
    <div className="skel-card" aria-hidden>
      <div className="skel-row">
        <span className="skeleton" style={{ width: 36, height: 36, borderRadius: "var(--radius-md)" }} />
        <div className="skel-row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <span className="skeleton" style={{ width: 120, height: 13 }} />
          <span className="skeleton" style={{ width: 160, height: 11 }} />
        </div>
      </div>
      <div className="skel-row" style={{ justifyContent: "space-between" }}>
        <span className="skeleton" style={{ width: 70, height: 11 }} />
        <span className="skeleton" style={{ width: 48, height: 11 }} />
      </div>
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const deployed = p.lastDeployedAt ? relativeTime(new Date(p.lastDeployedAt).getTime(), Date.now()) : null;
  // Live status per card via SSE; the list poll is the data fallback (see Projects).
  // Only deployed projects have a runtime to report on.
  const live = useLiveStatus(p.version ? p.slug : null);
  const { cls, label } = resolveStatus(live.status, p);

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
        <span className={cls}>
          <span className="dot" />
          {label}
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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ connectionString?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasKey = getToken() !== "";

  async function create() {
    setBusy(true); setErr(null);
    // Owner is bound to the signed-in account server-side; the body value is ignored.
    const res = await api.createProject(slug.trim(), "");
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
              <label>Database connection string <span className="faint">(shown once, store it now)</span></label>
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
        <div className="field"><label>Project name</label><input className="input mono" placeholder="my-app" value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
        {err && <span className="status status-error"><span className="dot" />{err}</span>}
        <div className="row">
          <button className="btn btn-invert" disabled={!hasKey || busy || !slug.trim()} onClick={create}>{busy ? "Creating…" : "Create project"}</button>
        </div>
      </div>
    </div>
  );
}
