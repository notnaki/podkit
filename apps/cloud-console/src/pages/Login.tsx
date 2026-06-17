import { useState } from "react";
import { api, setToken } from "../api/client.ts";
import { Logo } from "../components/Logo.tsx";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isSignup = mode === "signup";

  async function submit() {
    if (!email.trim() || !password) return;
    setBusy(true); setErr(null);
    const res = isSignup
      ? await api.signup(email.trim(), password)
      : await api.login(email.trim(), password);
    setBusy(false);
    if (res.ok) {
      setToken(res.data.token);
      onAuthed();
    } else {
      setErr(`${res.error.code}: ${res.error.message}`);
    }
  }

  return (
    <div className="app">
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
        <div className="panel" style={{ width: "100%", maxWidth: 380 }}>
          <div className="panel-head">
            <div className="row" style={{ gap: "var(--space-sm)" }}>
              <Logo size={18} />
              <h3>{isSignup ? "Create your account" : "Sign in to podkit"}</h3>
            </div>
          </div>
          <div className="panel-body stack">
            <div className="field">
              <label>Email</label>
              <input
                className="input"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                className="input"
                type="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              />
            </div>
            {err && <span className="status status-error"><span className="dot" />{err}</span>}
            <button className="btn btn-invert" disabled={busy || !email.trim() || !password} onClick={submit}>
              {busy ? (isSignup ? "Creating…" : "Signing in…") : (isSignup ? "Sign up" : "Login")}
            </button>
          </div>
          <div className="panel-foot">
            {isSignup ? "Already have an account? " : "New to podkit? "}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setMode(isSignup ? "login" : "signup"); setErr(null); }}
            >
              {isSignup ? "Login" : "Sign up"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
