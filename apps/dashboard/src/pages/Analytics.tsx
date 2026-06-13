import { api } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

export function Analytics() {
  const a = useApi(() => api.analytics(), []);
  const counts = a.data?.counts ?? {};
  const entries = Object.entries(counts).sort((x, y) => y[1] - x[1]);
  const max = entries.reduce((m, [, n]) => Math.max(m, n), 0) || 1;
  const total = entries.reduce((s, [, n]) => s + n, 0);

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Product events the app emits — page views and custom <span className="mono">track()</span> calls — aggregated by name.</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => a.reload()}>Refresh</button>
      </div>

      <section className="panel">
        <div className="panel-head"><h3>Events by name</h3><span className="eyebrow">{total} total</span></div>
        <div className="panel-body">
          {a.loading ? (
            <div className="state">Loading…</div>
          ) : a.error ? (
            <div className="state"><strong>{a.error.code}</strong><span>{a.error.message}</span></div>
          ) : entries.length === 0 ? (
            <div className="state"><strong>No events yet</strong><span>Call <span className="mono">track(sink, "signup")</span> from your app to populate this.</span></div>
          ) : (
            <div style={{ display: "grid", gap: "var(--space-sm)" }}>
              {entries.map(([name, n]) => (
                <div key={name} style={{ display: "grid", gridTemplateColumns: "180px 1fr 48px", gap: "var(--space-md)", alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: "var(--t-sm)" }}>{name}</span>
                  <span style={{ height: 8, background: "var(--surface-3)", borderRadius: 99, overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${(n / max) * 100}%`, background: "var(--accent)", borderRadius: 99 }} />
                  </span>
                  <span className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
