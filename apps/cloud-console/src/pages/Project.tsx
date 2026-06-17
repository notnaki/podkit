import { useState } from "react";
import { api, getToken, type Branch } from "../api/client.ts";
import { useApi, relativeTime } from "../lib/useApi.ts";
import { DataEditor } from "./DataEditor.tsx";

const TABS = ["Overview", "Deployments", "Database", "Observability", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function Project({ slug }: { slug: string }) {
  const detail = useApi(() => api.getProject(slug), [slug]);
  const [tab, setTab] = useState<Tab>("Overview");

  const url = detail.data?.url ?? null;
  const dep = detail.data?.latest ?? null;
  const running = dep?.status === "running";

  return (
    <>
      <div className="wrap-tight rise" style={{ paddingTop: "var(--space-xl)" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="row" style={{ gap: "var(--space-md)" }}>
            <span className="avatar" style={{ width: 44, height: 44, fontSize: "var(--t-lg)" }}>{slug.slice(0, 1).toUpperCase()}</span>
            <div>
              <h2 style={{ marginBottom: 4 }}>{slug}</h2>
              {url
                ? <a className="mono muted" href={url} target="_blank" rel="noreferrer" style={{ fontSize: "var(--t-sm)" }}>{url.replace(/^https?:\/\//, "")} ↗</a>
                : <span className="faint mono" style={{ fontSize: "var(--t-sm)" }}>not deployed</span>}
            </div>
          </div>
          <div className="row" style={{ gap: "var(--space-sm)" }}>
            {url && <CopyButton value={url} label="Copy URL" />}
            {url && <a className="btn" href={url} target="_blank" rel="noreferrer">Visit ↗</a>}
          </div>
        </div>
      </div>

      <div className="tabs">
        <div className="tabs-inner">
          {TABS.map((t) => (
            <button key={t} className={"tab" + (t === tab ? " active" : "")} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>

      <main className="wrap">
        {detail.loading ? (
          <div className="state">Loading…</div>
        ) : detail.error ? (
          <div className="state"><strong>{detail.error.code}</strong><span>{detail.error.message}</span></div>
        ) : tab === "Overview" ? (
          <div className="grid-2" style={{ alignItems: "start" }}>
            <section className="panel">
              <div className="panel-head">
                <h3>Production deployment</h3>
                <span className={running ? "status status-ready" : "status status-none"}><span className="dot" />{running ? "Ready" : dep ? dep.status : "None"}</span>
              </div>
              <div className="panel-body">
                {dep ? (
                  <dl className="kv">
                    <dt>Version</dt><dd className="mono">{dep.version}</dd>
                    <dt>URL</dt><dd>{url ? <a className="mono" style={{ color: "var(--link)" }} href={url} target="_blank" rel="noreferrer">{url}</a> : <span className="faint">—</span>}</dd>
                    <dt>Port</dt><dd className="mono">{dep.hostPort ?? "—"}</dd>
                  </dl>
                ) : (
                  <div className="state" style={{ padding: "var(--space-xl)" }}><strong>No deployment yet</strong><span>Deploy from the CLI: <span className="mono">podkit cloud deploy {slug}</span></span></div>
                )}
              </div>
              <div className="panel-foot">Deploys are immutable; promoting a new version reroutes the URL instantly.</div>
            </section>
            <section className="panel">
              <div className="panel-head"><h3>Project</h3></div>
              <div className="panel-body">
                <dl className="kv" style={{ gridTemplateColumns: "90px 1fr" }}>
                  <dt>Slug</dt><dd className="mono">{slug}</dd>
                  <dt>Owner</dt><dd>{detail.data?.project.owner ?? "—"}</dd>
                  <dt>ID</dt><dd className="mono faint" style={{ wordBreak: "break-all" }}>{detail.data?.project.id ?? "—"}</dd>
                </dl>
              </div>
            </section>
          </div>
        ) : tab === "Deployments" ? (
          <Deployments slug={slug} url={url} reload={detail.reload} />
        ) : tab === "Database" ? (
          <Database slug={slug} />
        ) : tab === "Observability" ? (
          <div className="stack">
            <Logs slug={slug} />
            <Metrics slug={slug} />
          </div>
        ) : (
          <div className="stack">
            <Domains slug={slug} />
            <Environment slug={slug} />
            <section className="panel">
              <div className="panel-head"><h3>Danger zone</h3></div>
              <div className="panel-body stack">
                <dl className="kv"><dt>Project ID</dt><dd className="mono faint" style={{ wordBreak: "break-all" }}>{detail.data?.project.id}</dd></dl>
                <DangerZone slug={slug} />
              </div>
            </section>
          </div>
        )}
      </main>
    </>
  );
}

function DangerZone({ slug }: { slug: string }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = getToken() !== "";
  const armed = confirm === slug;

  async function remove() {
    setBusy(true); setNote(null);
    const res = await api.deleteProject(slug);
    if (res.ok) {
      // Project is gone — return to the dashboard (projects list).
      window.location.hash = "#/dashboard";
    } else {
      setBusy(false);
      setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
    }
  }

  return (
    <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", gap: "var(--space-lg)", padding: "var(--space-md) 0 0", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontWeight: 600 }}>Delete project</div>
        <div className="faint" style={{ fontSize: "var(--t-sm)", maxWidth: "52ch" }}>Tears down the running container, drops the managed database and its role, and removes all deployments, env, and domains. This cannot be undone. Type <span className="mono">{slug}</span> to confirm.</div>
        {note && <span className="status status-error" style={{ marginTop: "var(--space-sm)" }}><span className="dot" />{note.text}</span>}
      </div>
      <div className="row" style={{ gap: "var(--space-sm)" }}>
        <input className="input mono" placeholder={slug} value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ width: 160 }} />
        <button className="btn btn-danger" disabled={!hasKey || !armed || busy} onClick={remove}>{busy ? "Deleting…" : "Delete"}</button>
      </div>
    </div>
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// Subtle, on-brand copy button: ghost styling, flips to a "Copied" state briefly.
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (insecure context / denied) — fail quietly.
    }
  }
  return (
    <button className="btn btn-ghost btn-sm" onClick={copy} title={`Copy ${value}`}>
      {copied ? "✓ Copied" : label}
    </button>
  );
}

function Deployments({ slug, url, reload }: { slug: string; url: string | null; reload: () => void }) {
  const history = useApi(() => api.listDeployments(slug), [slug]);
  const [rolling, setRolling] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = getToken() !== "";
  const list = history.data?.deployments ?? [];

  async function rollback(id: string, version: string) {
    setRolling(id); setNote(null);
    const res = await api.rollback(slug, id);
    setRolling(null);
    if (res.ok) { setNote({ ok: true, text: `rolled back to ${version}` }); history.reload(); reload(); }
    else setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h3>Deploy</h3></div>
        <div className="panel-body stack">
          <p className="muted" style={{ maxWidth: "60ch", margin: 0 }}>Deploy from your project directory — no path, port, or Dockerfile to configure:</p>
          <div className="mono" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "8px" }}>$ podkit cloud deploy {slug}</div>
          {note && <span className={note.ok ? "status status-ready" : "status status-error"}><span className="dot" />{note.text}</span>}
        </div>
        <div className="panel-foot">Deploys are immutable; each one reroutes the URL instantly — roll back below.</div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h3>Deployment history</h3>
          {url && (
            <div className="row" style={{ gap: "var(--space-sm)", alignItems: "center" }}>
              <a className="mono muted" href={url} target="_blank" rel="noreferrer" style={{ fontSize: "var(--t-sm)" }}>{url.replace(/^https?:\/\//, "")} ↗</a>
              <CopyButton value={url} label="Copy" />
            </div>
          )}
        </div>
        <div className="panel-body flush" style={{ padding: 0 }}>
          {history.loading ? (
            <div className="state">Loading…</div>
          ) : history.error ? (
            <div className="state"><strong>{history.error.code}</strong><span>{history.error.message}</span></div>
          ) : list.length === 0 ? (
            <div className="state"><strong>No deployments</strong><span>Deploy above or via <span className="mono">podkit cloud deploy {slug}</span>.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Version</th><th>Source</th><th>Status</th><th>Created</th><th style={{ width: 1 }} /></tr></thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.version}</td>
                    <td>{d.kind === "rollback" ? <span className="status status-building"><span className="dot" />rollback</span> : <span className="faint">deploy</span>}</td>
                    <td><span className={d.status === "running" ? "status status-ready" : "status status-none"}><span className="dot" />{d.status === "running" ? "Ready" : (d.status ?? "—")}</span></td>
                    <td className="faint mono" style={{ fontSize: "var(--t-sm)" }}>{fmtTime(d.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      {d.active
                        ? <span className="status status-ready"><span className="dot" />Current</span>
                        : <button className="btn btn-ghost" disabled={!hasKey || rolling !== null} onClick={() => rollback(d.id, d.version)}>{rolling === d.id ? "Rolling back…" : "Rollback"}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel-foot">Rolling back re-runs a previous build and instantly reroutes the URL to it.</div>
      </section>
      <Previews slug={slug} url={url} />
    </div>
  );
}

// Derive the gateway base (scheme://host[:port]) from a production project URL of
// the shape `<gateway>/_p/<slug>/`, so we can reconstruct a preview URL
// (`<gateway>/_p/<slug>--<branch>/`) for rows that only carry a branchId. Returns
// null when no production URL is available yet (project never deployed).
function gatewayBaseFrom(url: string | null): string | null {
  if (!url) return null;
  const idx = url.indexOf("/_p/");
  return idx === -1 ? null : url.slice(0, idx);
}

function previewUrlFor(base: string | null, slug: string, branchName: string): string | null {
  if (!base) return null;
  return base + "/_p/" + slug + "--" + branchName + "/";
}

// Branch previews: deploy a branch as an isolated container routed under
// <slug>--<branch>, list active/stopped previews, and tear them down. Signed-in
// only; the control plane re-validates ownership + branch existence and injects
// the branch's scoped DB connection string server-side.
function Previews({ slug, url }: { slug: string; url: string | null }) {
  const branches = useApi(() => api.listBranches(slug), [slug]);
  const previews = useApi(() => api.listPreviewDeployments(slug), [slug]);
  const [branchName, setBranchName] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{ branchName: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const hasKey = getToken() !== "";

  const branchList = branches.data?.branches ?? [];
  const list = previews.data?.deployments ?? [];
  // Map branchId -> name so the previews table (which carries only branchId) can
  // render branch names and reconstruct per-row preview URLs.
  const nameById = new Map<string, string>();
  for (const b of branchList) nameById.set(b.id, b.name);
  const gatewayBase = gatewayBaseFrom(url);

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true); setNote(null);
    const res = await api.deletePreview(slug, pending.branchName);
    setDeleting(false);
    if (res.ok) {
      setNote({ ok: true, text: `stopped ${pending.branchName}` });
      setPending(null);
      previews.reload();
    } else {
      setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
      setPending(null);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head"><h3>Deploy preview</h3></div>
        <div className="panel-body stack">
          <p className="muted" style={{ maxWidth: "60ch", margin: 0 }}>Pick a branch, then deploy a preview from your project directory with the CLI:</p>
          <div className="field">
            <label>Branch</label>
            <select
              className="input mono"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              disabled={!hasKey || branches.loading}
            >
              <option value="">{branches.loading ? "Loading branches…" : branchList.length === 0 ? "No branches — create one in Database" : "Select a branch…"}</option>
              {branchList.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
            </select>
          </div>
          <div className="mono" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "8px" }}>
            $ podkit cloud preview {slug} {branchName || "<branch>"}
          </div>
          {note && <span className={note.ok ? "status status-ready" : "status status-error"}><span className="dot" />{note.text}</span>}
        </div>
        <div className="panel-foot">Each preview gets its own URL at <span className="mono">{slug}--&lt;branch&gt;</span> with the branch&apos;s scoped database injected.</div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Previews</h3>
          {list.length > 0 && <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>{list.length} preview{list.length === 1 ? "" : "s"}</span>}
        </div>
        <div className="panel-body flush" style={{ padding: 0 }}>
          {previews.loading ? (
            <div className="state">Loading…</div>
          ) : previews.error ? (
            <div className="state"><strong>{previews.error.code}</strong><span>{previews.error.message}</span></div>
          ) : list.length === 0 ? (
            <div className="state"><strong>No previews</strong><span>Deploy a branch above to spin up an isolated preview.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Branch</th><th>Status</th><th>Created</th><th style={{ width: 1 }} /></tr></thead>
              <tbody>
                {list.map((d) => {
                  const bName = d.branchId ? nameById.get(d.branchId) ?? null : null;
                  const pUrl = bName ? previewUrlFor(gatewayBase, slug, bName) : null;
                  return (
                    <tr key={d.id}>
                      <td className="mono">
                        {bName
                          ? (pUrl ? <a style={{ color: "var(--link)" }} href={pUrl} target="_blank" rel="noreferrer">{bName} ↗</a> : bName)
                          : <span className="faint">{d.branchId ? "unknown branch" : "—"}</span>}
                      </td>
                      <td><span className={d.status === "running" ? "status status-ready" : "status status-none"}><span className="dot" />{d.status === "running" ? "Ready" : (d.status ?? "—")}</span></td>
                      <td className="faint mono" style={{ fontSize: "var(--t-sm)" }}>{fmtTime(d.createdAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="row" style={{ gap: "var(--space-sm)", justifyContent: "flex-end" }}>
                          {pUrl && <CopyButton value={pUrl} label="Copy preview URL" />}
                          {bName && <button className="btn btn-ghost" disabled={!hasKey || deleting} onClick={() => setPending({ branchName: bName })}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel-foot">Deleting a preview stops its container and clears its route. Production is unaffected.</div>
      </section>

      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => { if (!deleting) setPending(null); }}
          style={{ position: "fixed", inset: 0, background: "color-mix(in oklch, var(--bg) 70%, transparent)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-lg)", zIndex: 50 }}
        >
          <div className="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: "100%" }}>
            <div className="panel-head"><h3>Delete preview</h3></div>
            <div className="panel-body stack">
              <p className="muted" style={{ margin: 0, maxWidth: "52ch" }}>
                Tear down the preview for branch <span className="mono" style={{ color: "var(--text)" }}>{pending.branchName}</span>? This stops its container and clears its route. The branch and its database are not affected.
              </p>
              <div className="row" style={{ justifyContent: "flex-end", gap: "var(--space-sm)" }}>
                <button className="btn btn-ghost" disabled={deleting} onClick={() => setPending(null)}>Cancel</button>
                <button className="btn btn-danger" disabled={!hasKey || deleting} onClick={confirmDelete}>{deleting ? "Deleting…" : "Delete preview"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Logs({ slug }: { slug: string }) {
  const [lines, setLines] = useState("");
  const [since, setSince] = useState("");
  // applied filters drive the request; editing the inputs doesn't refetch until Apply.
  const [applied, setApplied] = useState<{ limit?: number; since?: string }>({});
  const logs = useApi(() => api.getLogs(slug, applied), [slug, applied]);
  const data = logs.data ?? null;
  const text = data?.logs ?? "";

  function apply() {
    const n = parseInt(lines, 10);
    setApplied({
      limit: Number.isFinite(n) && n > 0 ? n : undefined,
      since: since.trim() || undefined,
    });
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Runtime logs</h3>
        <div className="row" style={{ gap: "var(--space-md)", alignItems: "center" }}>
          {data?.version && <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>{data.version}</span>}
          <button className="btn btn-ghost" disabled={logs.loading} onClick={() => logs.reload()}>{logs.loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>
      <div className="row" style={{ gap: "var(--space-md)", alignItems: "flex-end", padding: "var(--space-md) var(--space-lg)", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <div className="field"><label>lines</label><input className="input mono" type="number" min={1} max={10000} placeholder="all" value={lines} onChange={(e) => setLines(e.target.value)} style={{ width: 100 }} /></div>
        <div className="field"><label>since (e.g. 2026-06-14T12:00 or 1h)</label><input className="input mono" placeholder="—" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 220 }} /></div>
        <button className="btn" disabled={logs.loading} onClick={apply}>Apply</button>
      </div>
      <div className="panel-body flush" style={{ padding: 0 }}>
        {logs.loading ? (
          <div className="state">Loading…</div>
        ) : logs.error ? (
          <div className="state"><strong>{logs.error.code}</strong><span>{logs.error.message}</span></div>
        ) : !data?.deploymentId ? (
          <div className="state"><strong>No deployment yet</strong><span>Deploy this project to see its container logs.</span></div>
        ) : text.trim() === "" ? (
          <div className="state"><strong>No log output</strong><span>The running container hasn&apos;t written anything to stdout/stderr yet.</span></div>
        ) : (
          <pre className="logs mono">{text}</pre>
        )}
      </div>
      <div className="panel-foot">Streamed from the active deployment&apos;s container (<span className="mono">docker logs</span>). Refresh to pull the latest.</div>
    </section>
  );
}

function Domains({ slug }: { slug: string }) {
  const domains = useApi(() => api.listDomains(slug), [slug]);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = getToken() !== "";
  const list = domains.data?.domains ?? [];

  async function add() {
    setBusy(true); setNote(null);
    const res = await api.addDomain(slug, domain.trim());
    setBusy(false);
    if (res.ok) {
      setNote({ ok: true, text: `added ${domain.trim()}` });
      setDomain("");
      domains.reload();
    } else {
      setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
    }
  }

  async function remove(d: string) {
    setNote(null);
    const res = await api.deleteDomain(slug, d);
    if (res.ok) { setNote({ ok: true, text: `removed ${d}` }); domains.reload(); }
    else setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h3>Custom domains</h3></div>
        <div className="panel-body flush" style={{ padding: 0 }}>
          {domains.loading ? (
            <div className="state">Loading…</div>
          ) : domains.error ? (
            <div className="state"><strong>{domains.error.code}</strong><span>{domains.error.message}</span></div>
          ) : list.length === 0 ? (
            <div className="state"><strong>No domains</strong><span>Add one below to route a custom hostname to this project.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Domain</th><th style={{ width: 1 }} /></tr></thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.domain}>
                    <td>
                      <a className="mono" style={{ color: "var(--link)" }} href={`https://${d.domain}`} target="_blank" rel="noreferrer">{d.domain} ↗</a>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-ghost" disabled={!hasKey} onClick={() => remove(d.domain)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel-foot">Point your domain&apos;s DNS (A / CNAME record) at the podkit gateway for traffic to route here.</div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>Add domain</h3></div>
        <div className="panel-body stack">
          {!hasKey && <span className="status status-building"><span className="dot" />sign in to edit</span>}
          <div className="field"><label>Domain</label><input className="input mono" placeholder="app.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} /></div>
          {note && <span className={note.ok ? "status status-ready" : "status status-error"}><span className="dot" />{note.text}</span>}
          <div className="row"><button className="btn btn-invert" disabled={!hasKey || busy || !domain.trim()} onClick={add}>{busy ? "Adding…" : "Add"}</button></div>
        </div>
      </section>
    </div>
  );
}

function Environment({ slug }: { slug: string }) {
  const env = useApi(() => api.listEnv(slug), [slug]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = getToken() !== "";
  const vars = env.data?.env ?? [];

  async function add() {
    setBusy(true); setNote(null);
    const res = await api.setEnv(slug, key.trim(), value, sensitive);
    setBusy(false);
    if (res.ok) {
      setNote({ ok: true, text: `saved ${key.trim()}` });
      setKey(""); setValue(""); setSensitive(false);
      env.reload();
    } else {
      setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
    }
  }

  async function remove(k: string) {
    setNote(null);
    const res = await api.deleteEnv(slug, k);
    if (res.ok) { setNote({ ok: true, text: `removed ${k}` }); env.reload(); }
    else setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h3>Environment variables</h3></div>
        <div className="panel-body flush" style={{ padding: 0 }}>
          {env.loading ? (
            <div className="state">Loading…</div>
          ) : env.error ? (
            <div className="state"><strong>{env.error.code}</strong><span>{env.error.message}</span></div>
          ) : vars.length === 0 ? (
            <div className="state"><strong>No variables</strong><span>Add one below to make it available to your deployment.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Key</th><th>Value</th><th style={{ width: 1 }} /></tr></thead>
              <tbody>
                {vars.map((v) => (
                  <tr key={v.key}>
                    <td className="mono">{v.key}</td>
                    <td>
                      {v.sensitive ? (
                        <span className="row" style={{ gap: "var(--space-sm)", alignItems: "center" }}>
                          <span className="mono faint">{"•".repeat(12)}</span>
                          <span className="status status-building"><span className="dot" />sensitive</span>
                        </span>
                      ) : (
                        <span className="mono">{v.value ?? "—"}</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-ghost" disabled={!hasKey} onClick={() => remove(v.key)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>Add variable</h3></div>
        <div className="panel-body stack">
          {!hasKey && <span className="status status-building"><span className="dot" />sign in to edit</span>}
          <div className="field"><label>Key</label><input className="input mono" placeholder="DATABASE_URL" value={key} onChange={(e) => setKey(e.target.value)} /></div>
          <div className="field"><label>Value</label><input className="input mono" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} /></div>
          <label className="row" style={{ gap: "var(--space-sm)", alignItems: "center" }}>
            <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
            <span>Sensitive</span>
          </label>
          {note && <span className={note.ok ? "status status-ready" : "status status-error"}><span className="dot" />{note.text}</span>}
          <div className="row"><button className="btn btn-invert" disabled={!hasKey || busy || !key.trim()} onClick={add}>{busy ? "Saving…" : "Add"}</button></div>
        </div>
      </section>
    </div>
  );
}

function Metrics({ slug }: { slug: string }) {
  const metrics = useApi(() => api.getMetrics(slug), [slug]);
  const m = metrics.data ?? null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Traffic</h3>
        <div className="row" style={{ gap: "var(--space-md)", alignItems: "center" }}>
          {m && m.lastSeen !== null && <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>last seen {relativeTime(m.lastSeen, Date.now())}</span>}
          <button className="btn btn-ghost" disabled={metrics.loading} onClick={() => metrics.reload()}>{metrics.loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>
      <div className="panel-body flush" style={{ padding: 0 }}>
        {metrics.loading ? (
          <div className="state">Loading…</div>
        ) : metrics.error ? (
          <div className="state"><strong>{metrics.error.code}</strong><span>{metrics.error.message}</span></div>
        ) : !m || m.requests === 0 ? (
          <div className="state"><strong>No traffic yet</strong><span>Once requests reach this project&apos;s deployment, you&apos;ll see request counts, status breakdown, and latency here.</span></div>
        ) : (
          <table className="table">
            <thead><tr><th>Metric</th><th style={{ textAlign: "right" }}>Value</th></tr></thead>
            <tbody>
              <tr><td>Total requests</td><td className="mono" style={{ textAlign: "right" }}>{m.requests.toLocaleString()}</td></tr>
              <tr><td><span className="status status-ready"><span className="dot" />2xx</span></td><td className="mono" style={{ textAlign: "right" }}>{m.status2xx.toLocaleString()}</td></tr>
              <tr><td><span className="status status-none"><span className="dot" />3xx</span></td><td className="mono" style={{ textAlign: "right" }}>{m.status3xx.toLocaleString()}</td></tr>
              <tr><td><span className="status status-building"><span className="dot" />4xx</span></td><td className="mono" style={{ textAlign: "right" }}>{m.status4xx.toLocaleString()}</td></tr>
              <tr><td><span className="status status-error"><span className="dot" />5xx</span></td><td className="mono" style={{ textAlign: "right" }}>{m.status5xx.toLocaleString()}</td></tr>
              <tr><td>Avg latency</td><td className="mono" style={{ textAlign: "right" }}>{Math.round(m.avgLatencyMs)} ms</td></tr>
            </tbody>
          </table>
        )}
      </div>
      <div className="panel-foot">Aggregated from the gateway across this project&apos;s active deployment.</div>
    </section>
  );
}

// Client-side branch-name guard mirrors the control-plane's validator
// (^[a-z0-9][a-z0-9_]{0,49}$) so we reject obviously-bad input before the
// round-trip; the server remains the authority.
const BRANCH_NAME_RE = /^[a-z0-9][a-z0-9_]{0,49}$/;

function Branches({ slug }: { slug: string }) {
  const branches = useApi(() => api.listBranches(slug), [slug]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // The scoped connection string is returned exactly once, at create time; we
  // surface it in a copyable block until the next create/dismiss.
  const [created, setCreated] = useState<{ name: string; connectionString: string } | null>(null);
  // Branch pending deletion (drives the confirmation modal); null = closed.
  const [pending, setPending] = useState<Branch | null>(null);
  const [deleting, setDeleting] = useState(false);
  const hasKey = getToken() !== "";
  const list = branches.data?.branches ?? [];
  const trimmed = name.trim();
  const valid = BRANCH_NAME_RE.test(trimmed);

  async function create() {
    if (!valid) return;
    setBusy(true); setNote(null); setCreated(null);
    const res = await api.createBranch(slug, trimmed);
    setBusy(false);
    if (res.ok) {
      setNote({ ok: true, text: `created ${res.data.branch.name}` });
      setCreated({ name: res.data.branch.name, connectionString: res.data.connectionString });
      setName("");
      branches.reload();
    } else {
      setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
    }
  }

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true); setNote(null);
    const res = await api.deleteBranch(slug, pending.name);
    setDeleting(false);
    if (res.ok) {
      setNote({ ok: true, text: `deleted ${pending.name}` });
      setPending(null);
      branches.reload();
    } else {
      setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
      setPending(null);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h3>Branches</h3>
          {list.length > 0 && <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>{list.length} branch{list.length === 1 ? "" : "es"}</span>}
        </div>
        <div className="panel-body flush" style={{ padding: 0 }}>
          {branches.loading ? (
            <div className="state">Loading…</div>
          ) : branches.error ? (
            <div className="state"><strong>{branches.error.code}</strong><span>{branches.error.message}</span></div>
          ) : list.length === 0 ? (
            <div className="state"><strong>No branches yet</strong><span>Create one below, or from the CLI: <span className="mono">podkit cloud branches create {slug} &lt;name&gt;</span></span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Name</th><th>Database</th><th>Created</th><th style={{ width: 1 }} /></tr></thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.name}</td>
                    <td className="mono faint">{b.database}</td>
                    <td className="faint mono" style={{ fontSize: "var(--t-sm)" }}>{fmtTime(b.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-ghost" disabled={!hasKey} onClick={() => setPending(b)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel-foot">Each branch is an isolated clone database with its own scoped role. The connection string is shown once, at create time.</div>
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Create branch</h3></div>
        <div className="panel-body stack">
          {!hasKey && <span className="status status-building"><span className="dot" />sign in to create branches</span>}
          <div className="field">
            <label>Branch name <span className="faint">— lowercase, digits, underscore (1-50)</span></label>
            <input
              className="input mono"
              placeholder="staging"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && hasKey && !busy && valid) create(); }}
            />
          </div>
          {trimmed !== "" && !valid && <span className="status status-error"><span className="dot" />name must match ^[a-z0-9][a-z0-9_]{"{0,49}"}$</span>}
          {note && <span className={note.ok ? "status status-ready" : "status status-error"}><span className="dot" />{note.text}</span>}
          <div className="row"><button className="btn btn-invert" disabled={!hasKey || busy || !valid} onClick={create}>{busy ? "Creating…" : "Create"}</button></div>
          {created && (
            <div className="field">
              <label>Connection string for <span className="mono">{created.name}</span> <span className="faint">— shown once, treat as a secret</span></label>
              <pre className="code" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{created.connectionString}</pre>
              <div className="row" style={{ gap: "var(--space-sm)" }}>
                <CopyButton value={created.connectionString} label="Copy" />
                <button className="btn btn-ghost btn-sm" onClick={() => setCreated(null)}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => { if (!deleting) setPending(null); }}
          style={{ position: "fixed", inset: 0, background: "color-mix(in oklch, var(--bg) 70%, transparent)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-lg)", zIndex: 50 }}
        >
          <div className="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: "100%" }}>
            <div className="panel-head"><h3>Delete branch</h3></div>
            <div className="panel-body stack">
              <p className="muted" style={{ margin: 0, maxWidth: "52ch" }}>
                Delete branch <span className="mono" style={{ color: "var(--text)" }}>{pending.name}</span>? This will drop the database <span className="mono" style={{ color: "var(--text)" }}>{pending.database}</span> and all its data. This cannot be undone.
              </p>
              <div className="row" style={{ justifyContent: "flex-end", gap: "var(--space-sm)" }}>
                <button className="btn btn-ghost" disabled={deleting} onClick={() => setPending(null)}>Cancel</button>
                <button className="btn btn-danger" disabled={!hasKey || deleting} onClick={confirmDelete}>{deleting ? "Deleting…" : "Delete branch"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Database({ slug }: { slug: string }) {
  const [sql, setSql] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; rowCount: number } | null>(null);
  const [err, setErr] = useState<{ code: string; message: string } | null>(null);
  const hasKey = getToken() !== "";
  const cols = result && result.rows.length > 0 ? Object.keys(result.rows[0]) : [];
  const shown = result ? result.rows.slice(0, 100) : [];

  async function run() {
    setBusy(true); setErr(null); setResult(null);
    const res = await api.runQuery(slug, sql.trim());
    setBusy(false);
    if (res.ok) setResult(res.data);
    else setErr(res.error);
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h3>Database</h3><span className="status status-ready"><span className="dot" />Postgres</span></div>
        <div className="panel-body">
          <p className="muted" style={{ marginBottom: "var(--space-md)", maxWidth: "60ch" }}>
            Every project gets a dedicated managed Postgres database, provisioned on creation. The connection string is shown once at create time (treat it as a secret).
          </p>
          <dl className="kv"><dt>Engine</dt><dd className="mono">postgres 16</dd><dt>Isolation</dt><dd>database-per-project</dd></dl>
        </div>
        <div className="panel-foot">Re-issuing connection strings &amp; scoped roles are on the roadmap.</div>
      </section>

      <DataEditor slug={slug} />

      <Branches slug={slug} />

      <section className="panel">
        <div className="panel-head">
          <h3>Query <span className="faint" style={{ fontWeight: 400, fontSize: "var(--t-sm)" }}>— advanced (read-only SQL)</span></h3>
          {result && <span className="mono faint" style={{ fontSize: "var(--t-sm)" }}>{result.rowCount} row{result.rowCount === 1 ? "" : "s"}</span>}
        </div>
        <div className="panel-body stack">
          {!hasKey && <span className="status status-building"><span className="dot" />sign in to run queries</span>}
          <div className="field">
            <label>SQL <span className="faint">— read-only SELECT, max 1000 rows</span></label>
            <textarea
              className="input mono"
              placeholder="select * from users limit 50;"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={4}
              style={{ height: "auto", padding: "10px 12px", resize: "vertical", lineHeight: 1.6 }}
            />
          </div>
          {err && <span className="status status-error"><span className="dot" />{err.code}: {err.message}</span>}
          <div className="row"><button className="btn btn-invert" disabled={!hasKey || busy || !sql.trim()} onClick={run}>{busy ? "Running…" : "Run"}</button></div>
        </div>
        {result && (
          <div className="panel-body flush" style={{ padding: 0, borderTop: "1px solid var(--border)" }}>
            {result.rows.length === 0 ? (
              <div className="state"><strong>No rows</strong><span>The query returned an empty result set.</span></div>
            ) : (
              <>
                <table className="table">
                  <thead><tr>{cols.map((c) => <th key={c} className="mono">{c}</th>)}</tr></thead>
                  <tbody>
                    {shown.map((rrow, i) => (
                      <tr key={i}>
                        {cols.map((c) => {
                          const v = rrow[c];
                          return <td key={c} className="mono" style={{ wordBreak: "break-word" }}>{v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.rows.length > shown.length && (
                  <div className="panel-foot">Showing first {shown.length} of {result.rowCount} rows.</div>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
