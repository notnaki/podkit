import { useState } from "react";
import { api, getToken } from "../api/client.ts";
import { useApi, relativeTime } from "../lib/useApi.ts";

const TABS = ["Overview", "Deployments", "Logs", "Metrics", "Database", "Domains", "Environment", "Settings"] as const;
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
          <div className="grid-2" style={{ gridTemplateColumns: "1.6fr 1fr", alignItems: "start" }}>
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
        ) : tab === "Logs" ? (
          <Logs slug={slug} />
        ) : tab === "Metrics" ? (
          <Metrics slug={slug} />
        ) : tab === "Database" ? (
          <Database slug={slug} />
        ) : tab === "Domains" ? (
          <Domains slug={slug} />
        ) : tab === "Environment" ? (
          <Environment slug={slug} />
        ) : (
          <section className="panel">
            <div className="panel-head"><h3>Settings</h3></div>
            <div className="panel-body stack">
              <dl className="kv"><dt>Project ID</dt><dd className="mono faint" style={{ wordBreak: "break-all" }}>{detail.data?.project.id}</dd></dl>
              <DangerZone slug={slug} />
            </div>
          </section>
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
      // Project is gone — return to the projects list.
      window.location.hash = "#/";
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
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState("");
  const [rolling, setRolling] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = getToken() !== "";
  const list = history.data?.deployments ?? [];

  async function deploy() {
    setBusy(true); setNote(null);
    const res = await api.deployProject(slug, ctx.trim(), 3000);
    setBusy(false);
    if (res.ok) { setNote({ ok: true, text: `deployed ${res.data.version}` }); setCtx(""); history.reload(); reload(); }
    else setNote({ ok: false, text: `${res.error.code}: ${res.error.message}` });
  }

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
          {!hasKey && <span className="status status-building"><span className="dot" />sign in to deploy</span>}
          <div className="field"><label>Build context (path to the app)</label><input className="input mono" placeholder="/abs/path/to/app" value={ctx} onChange={(e) => setCtx(e.target.value)} /></div>
          {note && <span className={note.ok ? "status status-ready" : "status status-error"}><span className="dot" />{note.text}</span>}
          <div className="row"><button className="btn btn-invert" disabled={!hasKey || busy || !ctx.trim()} onClick={deploy}>{busy ? "Building…" : "Deploy"}</button></div>
        </div>
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
    </div>
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

      <section className="panel">
        <div className="panel-head">
          <h3>Query</h3>
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
