import { useState } from "react";
import { api, getConfig } from "../api/client.ts";
import type { Project, ProjectDeployment } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

export function Projects() {
  const projects = useApi(() => api.listProjects(), []);
  const hasKey = getConfig().key !== "";

  const [slug, setSlug] = useState("");
  const [owner, setOwner] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ project: Project; database: string; connectionString: string } | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    setNote(null);
    setCreated(null);
    const res = await api.createProject(slug.trim(), owner.trim());
    setCreating(false);
    if (res.ok) {
      setCreated(res.data);
      setNote({ kind: "ok", text: `created ${res.data.project.slug}` });
      setSlug("");
      setOwner("");
      projects.reload();
    } else {
      setNote({ kind: "err", text: `${res.error.code}: ${res.error.message}` });
    }
  }

  const canCreate = hasKey && slug.trim() !== "" && owner.trim() !== "" && !creating;

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Provisioned projects on the cloud-host control-plane — each with its own database and an isolated deployment slot.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => projects.reload()}>Refresh</button>
      </div>

      {!hasKey && (
        <div className="panel"><div className="panel-body row" style={{ gap: "var(--space-sm)" }}>
          <span className="badge badge-warn"><span className="dot" />no API key</span>
          <span className="muted">Set an <span className="mono">x-podkit-key</span> in Connection to create projects.</span>
        </div></div>
      )}

      <section className="panel">
        <div className="panel-head"><h3>New project</h3></div>
        <div className="panel-body">
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label>Slug</label>
              <input className="input mono" value={slug} placeholder="my-app" onChange={(e) => setSlug(e.target.value)} />
            </div>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label>Owner</label>
              <input className="input mono" value={owner} placeholder="team@org" onChange={(e) => setOwner(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={!canCreate} onClick={create}>
              {creating ? "Creating…" : "Create project"}
            </button>
          </div>

          {note && (
            <div style={{ marginTop: "var(--space-md)" }}>
              <span className={note.kind === "ok" ? "badge badge-ok" : "badge badge-err"}><span className="dot" />{note.text}</span>
            </div>
          )}

          {created && (
            <div style={{ marginTop: "var(--space-md)" }}>
              <dl className="kv">
                <dt>Database</dt>
                <dd className="mono">{created.database}</dd>
              </dl>
              <p className="muted" style={{ margin: "var(--space-sm) 0 var(--space-2xs)" }}>Connection string — store it now, it won't be shown again.</p>
              <pre className="code">{created.connectionString}</pre>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Projects</h3>
          <span className="eyebrow">{projects.data?.projects.length ?? 0} total</span>
        </div>
        <div className="panel-body flush">
          {projects.loading ? (
            <div className="state">Loading…</div>
          ) : projects.error ? (
            <div className="state"><strong>{projects.error.code}</strong><span>{projects.error.message}</span></div>
          ) : !projects.data || projects.data.projects.length === 0 ? (
            <div className="state"><strong>No projects yet</strong><span>Create one above to provision a database and deployment slot.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Slug</th><th>Owner</th><th /></tr></thead>
              <tbody>
                {projects.data.projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    open={expanded === p.slug}
                    onToggle={() => setExpanded((cur) => (cur === p.slug ? null : p.slug))}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function ProjectRow({ project, open, onToggle }: { project: Project; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td className="mono">{project.slug}</td>
        <td>{project.owner}</td>
        <td style={{ textAlign: "right" }}>
          <button className="btn btn-ghost btn-sm" onClick={onToggle}>{open ? "Hide" : "Details"}</button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3} style={{ background: "var(--bg)" }}>
            <ProjectDetail slug={project.slug} />
          </td>
        </tr>
      )}
    </>
  );
}

function ProjectDetail({ slug }: { slug: string }) {
  const detail = useApi(() => api.getProject(slug), [slug]);

  if (detail.loading) return <p className="faint">Loading…</p>;
  if (detail.error) return <span className="badge badge-err"><span className="dot" />{detail.error.code}: {detail.error.message}</span>;

  const url = detail.data?.url ?? null;
  const deployment: ProjectDeployment | null = detail.data?.deployment ?? null;

  return (
    <dl className="kv">
      <dt>URL</dt>
      <dd>{url ? <a className="mono" href={url} target="_blank" rel="noreferrer">{url}</a> : <span className="faint">not deployed</span>}</dd>
      <dt>Latest deployment</dt>
      <dd>
        {deployment
          ? <span className="mono badge badge-accent"><span className="dot" />{deployment.version} · :{deployment.hostPort}</span>
          : <span className="faint">none yet</span>}
      </dd>
    </dl>
  );
}
