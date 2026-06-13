import { useState } from "react";
import { api } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

export function DocsPage() {
  const topics = useApi(() => api.docs(), []);
  const [topic, setTopic] = useState<string | null>(null);
  const list = topics.data?.topics ?? [];
  const selected = topic ?? list[0] ?? null;
  const doc = useApi(() => (selected ? api.doc(selected) : Promise.resolve({ ok: true, data: null } as const)), [selected]);

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Docs</h1>
          <p>The same machine-readable docs an agent reads via <span className="mono">podkit docs &lt;topic&gt;</span> — one source, two clients.</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "var(--space-lg)", alignItems: "start" }}>
        <nav className="panel" aria-label="topics">
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 1, padding: "var(--space-xs)" }}>
            {topics.loading ? (
              <span className="faint" style={{ padding: "var(--space-xs)" }}>Loading…</span>
            ) : list.length === 0 ? (
              <span className="faint" style={{ padding: "var(--space-xs)" }}>No topics</span>
            ) : (
              list.map((t) => (
                <button key={t} className={"nav-item" + (t === selected ? " active" : "")} style={{ textAlign: "left" }} onClick={() => setTopic(t)}>
                  {t}
                </button>
              ))
            )}
          </div>
        </nav>

        <section className="panel">
          <div className="panel-head"><h3 className="mono">{selected ?? "—"}</h3></div>
          <div className="panel-body">
            {doc.loading ? (
              <p className="faint">Loading…</p>
            ) : doc.error ? (
              <p className="badge badge-err"><span className="dot" />{doc.error.message}</p>
            ) : doc.data ? (
              <>
                <h2 style={{ marginBottom: "var(--space-sm)" }}>{doc.data.title}</h2>
                <div className="code" style={{ whiteSpace: "pre-wrap", maxWidth: "72ch" }}>{doc.data.content}</div>
              </>
            ) : (
              <p className="faint">Select a topic.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
