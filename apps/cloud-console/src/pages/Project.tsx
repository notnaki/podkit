import { useState } from "react";
import { api, getToken } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

const TABS = ["Overview", "Deployments", "Storage", "Domains", "Environment", "Settings"] as const;
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
          {url && <a className="btn" href={url} target="_blank" rel="noreferrer">Visit ↗</a>}
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
          <Deployments slug={slug} dep={dep} url={url} reload={detail.reload} />
        ) : tab === "Storage" ? (
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
        ) : tab === "Domains" ? (
          <Domains slug={slug} />
        ) : tab === "Environment" ? (
          <Environment slug={slug} />
        ) : (
          <section className="panel">
            <div className="panel-head"><h3>Settings</h3></div>
            <div className="panel-body stack">
              <dl className="kv"><dt>Project ID</dt><dd className="mono faint" style={{ wordBreak: "break-all" }}>{detail.data?.project.id}</dd></dl>
              <div className="row" style={{ justifyContent: "space-between", padding: "var(--space-sm) 0", borderTop: "1px solid var(--border)" }}>
                <div><div style={{ fontWeight: 600 }}>Delete project</div><div className="faint" style={{ fontSize: "var(--t-sm)" }}>Tears down the container and database. Not yet available.</div></div>
                <button className="btn btn-danger" disabled>Delete</button>
              </div>
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function Deployments({ slug, dep, url, reload }: { slug: string; dep: { version: string; status?: string } | null; url: string | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKey = getToken() !== "";

  async function deploy() {
    setBusy(true); setNote(null);
    const res = await api.deployProject(slug, ctx.trim(), 3000);
    setBusy(false);
    if (res.ok) { setNote({ ok: true, text: `deployed ${res.data.version}` }); reload(); }
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
        <div className="panel-head"><h3>Production</h3></div>
        <div className="panel-body flush" style={{ padding: 0 }}>
          {dep ? (
            <table className="table">
              <thead><tr><th>Version</th><th>Status</th><th>URL</th></tr></thead>
              <tbody><tr>
                <td className="mono">{dep.version}</td>
                <td><span className={dep.status === "running" ? "status status-ready" : "status status-none"}><span className="dot" />{dep.status === "running" ? "Ready" : dep.status}</span></td>
                <td>{url ? <a className="mono" style={{ color: "var(--link)" }} href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, "")}</a> : "—"}</td>
              </tr></tbody>
            </table>
          ) : <div className="state"><strong>No deployments</strong><span>Deploy above or via <span className="mono">podkit cloud deploy {slug}</span>.</span></div>}
        </div>
      </section>
    </div>
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
