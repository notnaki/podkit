import { useEffect, useState } from "react";
import { api, getConfig, setConfig } from "./api/client.ts";
import { useApi } from "./lib/useApi.ts";
import { Projects } from "./pages/Projects.tsx";
import { Project } from "./pages/Project.tsx";

type Route = { page: "projects" } | { page: "project"; slug: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  const m = h.match(/^p\/(.+)$/);
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
        </nav>
        <span className="spacer" />
        <span className={"status " + (health.loading ? "status-none" : connected ? "status-ready" : "status-error")}>
          <span className="dot" />
          {health.loading ? "connecting" : connected ? "control-plane" : "offline"}
        </span>
        <Connect onSaved={() => location.reload()} />
      </header>

      {route.page === "projects" ? <Projects /> : <Project slug={route.slug} />}
    </div>
  );
}

function Connect({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const cfg = getConfig();
  const [url, setUrl] = useState(cfg.url);
  const [key, setKey] = useState(cfg.key);
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
            <div className="field">
              <label>API key (x-podkit-key)</label>
              <input className="input mono" type="password" placeholder="for create / deploy" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <button className="btn btn-invert" onClick={() => { setConfig(url, key); onSaved(); }}>Save & reconnect</button>
          </div>
        </div>
      )}
    </div>
  );
}
