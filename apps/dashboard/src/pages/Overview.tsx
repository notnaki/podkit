import { api } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

export function Overview() {
  const project = useApi(() => api.project(), []);
  const deps = useApi(() => api.deployments(), []);

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>The shape of this project as the control-plane sees it — routes, data, identity, and what's live.</p>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h3>Project</h3></div>
          <div className="panel-body">
            {project.loading ? (
              <p className="faint">Loading…</p>
            ) : project.error ? (
              <p className="badge badge-err"><span className="dot" />{project.error.code}</p>
            ) : (
              <dl className="kv">
                <dt>Routes</dt>
                <dd className="mono">{project.data?.routes.length ?? 0}</dd>
                <dt>Database</dt>
                <dd>{project.data?.hasDb ? <span className="badge badge-ok"><span className="dot" />schema present</span> : <span className="faint">none</span>}</dd>
                <dt>Auth</dt>
                <dd>{project.data?.hasAuth ? <span className="badge badge-ok"><span className="dot" />configured</span> : <span className="faint">tokens only</span>}</dd>
              </dl>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Live deployment</h3>
            <a href="#deployments" className="btn btn-ghost btn-sm">Manage →</a>
          </div>
          <div className="panel-body">
            {deps.loading ? (
              <p className="faint">Loading…</p>
            ) : deps.error ? (
              <p className="badge badge-err"><span className="dot" />{deps.error.code}</p>
            ) : (
              <dl className="kv">
                <dt>Current</dt>
                <dd>{deps.data?.current ? <span className="mono badge badge-accent"><span className="dot" />{deps.data.current}</span> : <span className="faint">nothing promoted</span>}</dd>
                <dt>Versions</dt>
                <dd className="mono">{deps.data?.versions.length ?? 0}</dd>
              </dl>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>Routes</h3>
          <span className="eyebrow">{project.data?.routes.length ?? 0} total</span>
        </div>
        <div className="panel-body flush">
          {project.loading ? (
            <div className="state">Loading routes…</div>
          ) : !project.data || project.data.routes.length === 0 ? (
            <div className="state"><strong>No routes discovered</strong><span>Add files under <span className="mono">app/routes</span>.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Pattern</th><th>Kind</th><th>File</th></tr></thead>
              <tbody>
                {project.data.routes.map((r) => (
                  <tr key={r.file}>
                    <td className="mono">{r.pattern}</td>
                    <td><span className={"badge" + (r.kind === "static" ? "" : " badge-accent")}>{r.kind}</span></td>
                    <td className="mono faint">{r.file}</td>
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
