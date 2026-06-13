import { api } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

const OPS = [
  { cmd: "podkit db migrate", desc: "Generate a migration from your TS schema and apply it." },
  { cmd: "podkit db pull", desc: "Introspect the live database and capture out-of-band DDL as a migration." },
  { cmd: "podkit db studio", desc: "Open the schema/SQL studio (coming soon)." },
];

export function Database() {
  const project = useApi(() => api.project(), []);

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Database</h1>
          <p>Real Postgres with schema-as-code. Migrations are versioned files; row-level security is declared alongside the schema.</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h3>Status</h3></div>
        <div className="panel-body">
          {project.loading ? (
            <p className="faint">Loading…</p>
          ) : (
            <dl className="kv">
              <dt>Schema</dt>
              <dd>{project.data?.hasDb
                ? <span className="badge badge-ok"><span className="dot" /><span className="mono">app/db/schema.ts</span> present</span>
                : <span className="faint">no schema file</span>}</dd>
              <dt>Engine</dt>
              <dd className="mono">postgres · pglite (local)</dd>
            </dl>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h3>Operations</h3><span className="eyebrow">via CLI</span></div>
        <div className="panel-body flush">
          <table className="table">
            <tbody>
              {OPS.map((o) => (
                <tr key={o.cmd}>
                  <td className="mono" style={{ width: 220 }}>{o.cmd}</td>
                  <td className="muted">{o.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="faint" style={{ fontSize: "var(--t-sm)" }}>
        Schema browsing and migration history over the control-plane API are on the roadmap.
      </p>
    </div>
  );
}
