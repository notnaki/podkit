import { useState } from "react";
import { api, getConfig } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

export function Deployments() {
  const deps = useApi(() => api.deployments(), []);
  const [busy, setBusy] = useState<null | "deploy" | "rollback">(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const hasKey = getConfig().key !== "";

  async function act(which: "deploy" | "rollback") {
    setBusy(which);
    setNote(null);
    const res = which === "deploy" ? await api.deploy() : await api.rollback();
    setBusy(null);
    if (res.ok) {
      setNote({ kind: "ok", text: which === "deploy" ? `deployed ${(res.data as { versionId: string }).versionId}` : `rolled back to ${(res.data as { to: string }).to}` });
      deps.reload();
    } else {
      setNote({ kind: "err", text: `${res.error.code}: ${res.error.message}` });
    }
  }

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Deployments</h1>
          <p>Immutable versions with an atomic current pointer. Promote by deploying; roll back instantly to the previous version.</p>
        </div>
        <div className="row">
          <button className="btn btn-danger" disabled={!hasKey || busy !== null} onClick={() => act("rollback")}>
            {busy === "rollback" ? "Rolling back…" : "Rollback"}
          </button>
          <button className="btn btn-primary" disabled={!hasKey || busy !== null} onClick={() => act("deploy")}>
            {busy === "deploy" ? "Deploying…" : "Deploy current"}
          </button>
        </div>
      </div>

      {!hasKey && (
        <div className="panel"><div className="panel-body row" style={{ gap: "var(--space-sm)" }}>
          <span className="badge badge-warn"><span className="dot" />no API key</span>
          <span className="muted">Set an <span className="mono">x-podkit-key</span> in Connection to deploy or roll back.</span>
        </div></div>
      )}

      {note && (
        <div className="panel"><div className="panel-body">
          <span className={note.kind === "ok" ? "badge badge-ok" : "badge badge-err"}><span className="dot" />{note.text}</span>
        </div></div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3>Versions</h3>
          <button className="btn btn-ghost btn-sm" onClick={() => deps.reload()}>Refresh</button>
        </div>
        <div className="panel-body flush">
          {deps.loading ? (
            <div className="state">Loading…</div>
          ) : deps.error ? (
            <div className="state"><strong>{deps.error.code}</strong><span>{deps.error.message}</span></div>
          ) : !deps.data || deps.data.versions.length === 0 ? (
            <div className="state"><strong>No versions yet</strong><span>Hit “Deploy current” to publish the first one.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Version</th><th>State</th></tr></thead>
              <tbody>
                {[...deps.data.versions].reverse().map((v) => (
                  <tr key={v}>
                    <td className="mono">{v}</td>
                    <td>
                      {v === deps.data!.current
                        ? <span className="badge badge-ok"><span className="dot" />current</span>
                        : <span className="faint">superseded</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
