import { useState } from "react";
import { api } from "../api/client.ts";

export function CliAuthorize({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function approve() {
    if (!code) return;
    setBusy(true); setErr(null);
    const res = await api.cliApprove(code);
    setBusy(false);
    if (res.ok) setDone(true);
    else setErr(`${res.error.code}: ${res.error.message}`);
  }

  return (
    <main
      className="rise"
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-xl)",
      }}
    >
      <div className="panel" style={{ width: "100%", maxWidth: 420 }}>
        <div className="panel-head"><h3>Authorize the podkit CLI</h3></div>
        <div className="panel-body stack">
          {done ? (
            <span className="status status-ready"><span className="dot" />✓ Approved — return to your terminal.</span>
          ) : (
            <>
              <p className="muted" style={{ maxWidth: "44ch" }}>
                A device wants to sign in to your podkit account. Confirm the code below matches the one shown in your terminal, then approve.
              </p>
              <div className="field">
                <label>Device code</label>
                <div className="code mono" style={{ fontSize: "var(--t-lg)", letterSpacing: "0.15em", textAlign: "center" }}>
                  {code || "(missing code)"}
                </div>
              </div>
              {err && <span className="status status-error"><span className="dot" />{err}</span>}
              <div className="row">
                <button className="btn btn-invert" disabled={busy || !code} onClick={approve}>
                  {busy ? "Approving…" : "Approve"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
