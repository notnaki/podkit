import { useEffect, useState } from "react";
import { api, getApiUrl, setApiUrl, getToken, clearToken } from "./api/client.ts";
import type { Account } from "./api/client.ts";
import { useApi } from "./lib/useApi.ts";
import { Projects } from "./pages/Projects.tsx";
import { Project } from "./pages/Project.tsx";
import { Login } from "./pages/Login.tsx";
import { CliAuthorize } from "./pages/CliAuthorize.tsx";

type Route =
  | { page: "projects" }
  | { page: "project"; slug: string }
  | { page: "cli"; code: string };

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  if (path === "cli") {
    const code = new URLSearchParams(query ?? "").get("code") ?? "";
    return { page: "cli", code };
  }
  const m = path.match(/^p\/(.+)$/);
  if (m) return { page: "project", slug: decodeURIComponent(m[1]) };
  return { page: "projects" };
}

function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => window.scrollTo(0, 0), [JSON.stringify(route)]);
  return route;
}

export function App() {
  const [authed, setAuthed] = useState(getToken() !== "");
  const [account, setAccount] = useState<Account | null>(null);
  const [checking, setChecking] = useState(getToken() !== "");

  function reload() {
    setAuthed(getToken() !== "");
    setChecking(getToken() !== "");
    setAccount(null);
  }

  useEffect(() => {
    if (!authed) { setChecking(false); return; }
    let alive = true;
    setChecking(true);
    api.me().then((res) => {
      if (!alive) return;
      if (res.ok) {
        setAccount(res.data.account);
        setChecking(false);
      } else {
        // 401 (or any auth failure): drop the token and fall back to Login.
        clearToken();
        setAccount(null);
        setAuthed(false);
        setChecking(false);
      }
    });
    return () => { alive = false; };
  }, [authed]);

  if (!authed) return <Login onAuthed={reload} />;

  if (checking) {
    return (
      <div className="app">
        <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="status status-none"><span className="dot" />loading…</span>
        </main>
      </div>
    );
  }

  return <Console account={account} onSignOut={() => { clearToken(); reload(); }} />;
}

function Console({ account, onSignOut }: { account: Account | null; onSignOut: () => void }) {
  const route = useRoute();
  const health = useApi(() => api.health(), []);
  const connected = health.data?.status === "ok";

  return (
    <div className="app">
      <header className="topnav">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 1.5 16.5 15h-15L9 1.5Z" fill="currentColor" /></svg>
          </span>
          podkit
        </a>
        <span className="crumb-sep">/</span>
        <nav className="crumb muted">
          <a href="#/">cloud</a>
          {route.page === "project" && (
            <>
              <span className="crumb-sep">/</span>
              <span className="mono" style={{ color: "var(--text)" }}>{route.slug}</span>
            </>
          )}
          {route.page === "cli" && (
            <>
              <span className="crumb-sep">/</span>
              <span className="mono" style={{ color: "var(--text)" }}>authorize</span>
            </>
          )}
        </nav>
        <span className="spacer" />
        <span className={"status " + (health.loading ? "status-none" : connected ? "status-ready" : "status-error")}>
          <span className="dot" />
          {health.loading ? "connecting" : connected ? "control-plane" : "offline"}
        </span>
        {account && <span className="muted mono" style={{ fontSize: "var(--t-sm)" }}>{account.email}</span>}
        <Connect onSaved={() => location.reload()} />
        <button className="btn btn-sm btn-ghost" onClick={onSignOut}>Sign out</button>
      </header>

      {route.page === "cli" ? (
        <CliAuthorize code={route.code} />
      ) : route.page === "project" ? (
        <Project slug={route.slug} />
      ) : (
        <Projects />
      )}
    </div>
  );
}

function Connect({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(getApiUrl());
  return (
    <div style={{ position: "relative" }}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Connect"}</button>
      {open && (
        <div className="popover panel rise">
          <div className="panel-body" style={{ display: "grid", gap: "var(--space-sm)" }}>
            <div className="field">
              <label>Control-plane URL</label>
              <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <button className="btn btn-invert" onClick={() => { setApiUrl(url); onSaved(); }}>Save & reconnect</button>
          </div>
        </div>
      )}
    </div>
  );
}
