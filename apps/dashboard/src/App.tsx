import { useEffect, useState } from "react";
import { getConfig, setConfig, api } from "./api/client.ts";
import { useApi } from "./lib/useApi.ts";
import { Projects } from "./pages/Projects.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Deployments } from "./pages/Deployments.tsx";
import { Database } from "./pages/Database.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { Logs } from "./pages/Logs.tsx";
import { Analytics } from "./pages/Analytics.tsx";
import { DocsPage } from "./pages/DocsPage.tsx";

const NAV = [
  { id: "projects", label: "Projects", el: <Projects /> },
  { id: "overview", label: "Overview", el: <Overview /> },
  { id: "deployments", label: "Deployments", el: <Deployments /> },
  { id: "database", label: "Database", el: <Database /> },
  { id: "auth", label: "Auth", el: <AuthPage /> },
  { id: "logs", label: "Logs", el: <Logs /> },
  { id: "analytics", label: "Analytics", el: <Analytics /> },
  { id: "docs", label: "Docs", el: <DocsPage /> },
] as const;

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "overview");
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || "overview");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const route = useHashRoute();
  const active = NAV.find((n) => n.id === route) ?? NAV[0];
  const health = useApi(() => api.health(), []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active.id]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>◇</span>
          <span className="brand-name">podkit</span>
          <span className="brand-tag mono">console</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} className={"nav-item" + (n.id === active.id ? " active" : "")}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ConnState ok={health.data?.status === "ok"} loading={health.loading} />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            <span className="faint">podkit</span>
            <span className="faint">/</span>
            <span>{active.label}</span>
          </div>
          <Settings onSaved={() => location.reload()} />
        </header>
        <main className="content" key={active.id}>
          {active.el}
        </main>
      </div>
    </div>
  );
}

function ConnState({ ok, loading }: { ok: boolean; loading: boolean }) {
  const cls = loading ? "badge" : ok ? "badge badge-ok" : "badge badge-err";
  return (
    <span className={cls}>
      <span className="dot" />
      {loading ? "connecting" : ok ? "control-plane" : "offline"}
    </span>
  );
}

function Settings({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const cfg = getConfig();
  const [url, setUrl] = useState(cfg.url);
  const [key, setKey] = useState(cfg.key);
  return (
    <div className="settings">
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Connection"}
      </button>
      {open && (
        <div className="popover panel rise">
          <div className="panel-body" style={{ display: "grid", gap: "var(--space-sm)", width: 320 }}>
            <div className="field">
              <label>Control-plane URL</label>
              <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="field">
              <label>API key (x-podkit-key)</label>
              <input
                className="input mono"
                type="password"
                value={key}
                placeholder="for deploy / token actions"
                onChange={(e) => setKey(e.target.value)}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                setConfig(url, key);
                onSaved();
              }}
            >
              Save & reconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
