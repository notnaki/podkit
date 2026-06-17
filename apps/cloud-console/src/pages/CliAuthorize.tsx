import { useState } from "react";
import { api } from "../api/client.ts";

export function CliAuthorize() {
  const [typedCode, setTypedCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function approve() {
    if (!typedCode.trim()) return;
    setBusy(true); setErr(null);
    const res = await api.cliApprove(typedCode.trim());
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
            <span className="status status-ready"><span className="dot" />&#10003; Approved. Return to your terminal.</span>
          ) : (
            <>
              <p className="muted" style={{ maxWidth: "44ch" }}>
                Enter the device code shown in your terminal to authorize the CLI.
              </p>
              <div className="field">
                <label>Device code</label>
                <input
                  className="input mono"
                  style={{ fontSize: "var(--t-lg)", letterSpacing: "0.15em", textAlign: "center" }}
                  placeholder="e.g. a1b2c3d4"
                  value={typedCode}
                  onChange={(e) => setTypedCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void approve(); }}
                  autoFocus
                />
              </div>
              {err && <span className="status status-error"><span className="dot" />{err}</span>}
              <div className="row">
                <button
                  className="btn btn-invert"
                  disabled={busy || !typedCode.trim()}
                  onClick={() => void approve()}
                >
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
