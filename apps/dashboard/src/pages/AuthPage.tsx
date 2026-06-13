import { useState } from "react";
import { api, getConfig } from "../api/client.ts";

export function AuthPage() {
  const [userId, setUserId] = useState("");
  const [scopes, setScopes] = useState("read");
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasKey = getConfig().key !== "";

  async function issue() {
    setBusy(true); setErr(null); setToken(null); setCopied(false);
    const scopeList = scopes.split(",").map((s) => s.trim()).filter(Boolean);
    const res = await api.authToken(userId.trim(), scopeList);
    setBusy(false);
    if (res.ok) setToken(res.data.token);
    else setErr(`${res.error.code}: ${res.error.message}`);
  }

  return (
    <div className="stack rise">
      <div className="page-head">
        <div>
          <h1>Auth</h1>
          <p>Two first-class identities: human users and <strong>agent tokens</strong>. Mint a scoped token for an agent to act on the platform.</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-lg)", alignItems: "start" }}>
        <section className="panel">
          <div className="panel-head"><h3>Issue agent token</h3></div>
          <div className="panel-body" style={{ display: "grid", gap: "var(--space-md)" }}>
            {!hasKey && (
              <span className="badge badge-warn"><span className="dot" />set an API key in Connection to issue tokens</span>
            )}
            <div className="field">
              <label>User ID the agent acts as</label>
              <input className="input mono" placeholder="usr_…" value={userId} onChange={(e) => setUserId(e.target.value)} />
            </div>
            <div className="field">
              <label>Scopes (comma-separated)</label>
              <input className="input mono" placeholder="read, write" value={scopes} onChange={(e) => setScopes(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={!hasKey || busy || !userId.trim()} onClick={issue}>
              {busy ? "Issuing…" : "Issue token"}
            </button>
            {err && <span className="badge badge-err"><span className="dot" />{err}</span>}
            {token && (
              <div className="field">
                <label>Token <span className="faint">— store it now, it won't be shown again</span></label>
                <div className="code" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{token}</div>
                <button className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(token); setCopied(true); }}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Identities</h3></div>
          <div className="panel-body">
            <dl className="kv" style={{ gridTemplateColumns: "110px 1fr" }}>
              <dt>Humans</dt>
              <dd className="muted">Email + password sessions. Created via <span className="mono">podkit auth signup</span>.</dd>
              <dt>Agents</dt>
              <dd className="muted">Scoped, signed tokens — attributable in every log line. Verify with <span className="mono">podkit auth whoami</span>.</dd>
              <dt>RLS</dt>
              <dd className="muted">The session identity drives Postgres row-level security automatically.</dd>
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}
