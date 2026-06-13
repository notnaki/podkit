import { useState } from "react";
import { api } from "../api/client.ts";
import type { LogEvent } from "../api/client.ts";
import { useApi } from "../lib/useApi.ts";

const LEVELS = ["all", "info", "warn", "error", "debug"] as const;

function levelBadge(level?: string) {
  if (level === "error") return "badge badge-err";
  if (level === "warn") return "badge badge-warn";
  if (level === "debug") return "badge";
  return "badge badge-accent";
}

export function Logs() {
  const logs = useApi(() => api.logs(), []);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");

  const events: LogEvent[] = (logs.data?.events ?? []).filter(
    (e) => level === "all" || e.level === level,
  );

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Logs</h1>
          <p>Every request the runtime serves, captured structurally — attributable to a human or an agent.</p>
        </div>
        <div className="row">
          {LEVELS.map((l) => (
            <button key={l} className={"btn btn-sm" + (l === level ? " btn-primary" : " btn-ghost")} onClick={() => setLevel(l)}>{l}</button>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => logs.reload()}>Refresh</button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h3>Request log</h3><span className="eyebrow">{events.length} events</span></div>
        <div className="panel-body flush">
          {logs.loading ? (
            <div className="state">Loading…</div>
          ) : logs.error ? (
            <div className="state"><strong>{logs.error.code}</strong><span>{logs.error.message}</span></div>
          ) : events.length === 0 ? (
            <div className="state"><strong>No log events</strong><span>Serve some requests with <span className="mono">podkit dev</span> to populate this.</span></div>
          ) : (
            <table className="table">
              <thead><tr><th>Level</th><th>Message</th><th>Route</th><th>Who</th><th>Request</th></tr></thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={e.requestId ?? i}>
                    <td><span className={levelBadge(e.level)}><span className="dot" />{e.level ?? "log"}</span></td>
                    <td className="mono">{e.message ?? ""}</td>
                    <td className="mono faint">{e.route ?? "—"}</td>
                    <td className="mono">{e.identity ?? <span className="faint">anon</span>}</td>
                    <td className="mono faint">{e.requestId ?? "—"}</td>
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
