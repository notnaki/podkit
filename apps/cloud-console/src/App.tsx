import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, getToken, clearToken } from "./api/client.ts";
import type { Account } from "./api/client.ts";
import { useApi } from "./lib/useApi.ts";
import { Projects } from "./pages/Projects.tsx";
import { Project } from "./pages/Project.tsx";
import { Login } from "./pages/Login.tsx";
import { CliAuthorize } from "./pages/CliAuthorize.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Docs } from "./pages/Docs.tsx";

type Route =
  | { page: "landing" }
  | { page: "docs" }
  | { page: "login" }
  | { page: "dashboard" }
  | { page: "project"; slug: string }
  | { page: "cli" };

// Which routes require a signed-in account. Public routes render for everyone.
const GATED: ReadonlyArray<Route["page"]> = ["dashboard", "project", "cli"];

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path] = raw.split("?");
  if (path === "docs") return { page: "docs" };
  if (path === "login") return { page: "login" };
  if (path === "dashboard") return { page: "dashboard" };
  if (path === "cli") return { page: "cli" };
  const m = path.match(/^p\/(.+)$/);
  if (m) return { page: "project", slug: decodeURIComponent(m[1]) };
  return { page: "landing" };
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
        // 401 (or any auth failure): drop the token and fall back to logged-out.
        clearToken();
        setAccount(null);
        setAuthed(false);
        setChecking(false);
      }
    });
    return () => { alive = false; };
  }, [authed]);

  const gated = GATED.includes(route.page);

  // Public pages render for everyone — including while a token is being verified.
  if (route.page === "landing") {
    return <Shell account={authed ? account : null}><Landing /></Shell>;
  }
  if (route.page === "docs") {
    return <Shell account={authed ? account : null}><Docs /></Shell>;
  }

  // Already signed in but on the sign-in route: send them to the dashboard.
  if (route.page === "login" && authed) {
    location.hash = "#/dashboard";
    return null;
  }

  // The explicit sign-in route, and the fallback for gated pages while logged out.
  if (route.page === "login" || (gated && !authed)) {
    return <Login onAuthed={() => { reload(); location.hash = "#/dashboard"; }} />;
  }

  // Gated pages, signed in: wait for the me() check before rendering the console.
  if (checking) {
    return (
      <div className="app">
        <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="status status-none"><span className="dot" />loading…</span>
        </main>
      </div>
    );
  }

  return <Console route={route} account={account} onSignOut={() => { clearToken(); reload(); location.hash = "#/"; }} />;
}

// Lighter public chrome for landing + docs: brand, Docs, and a sign-in / dashboard
// affordance. No health pill, no Connect — those belong on the app surface.
function PublicNav({ account }: { account: Account | null }) {
  const route = useRoute();
  return (
    <header className="topnav topnav-public">
      <a className="brand" href="#/">
        <span className="logo" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="1" y="1" width="7" height="7" rx="2.2" fill="currentColor" /><rect x="10" y="1" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /><rect x="1" y="10" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /><rect x="10" y="10" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /></svg>
        </span>
        podkit
      </a>
      <span className="spacer" />
      <nav className="nav-links">
        <a className={"nav-link" + (route.page === "docs" ? " active" : "")} href="#/docs">Docs</a>
        {account ? (
          <>
            <a className="nav-link" href="#/dashboard">Dashboard</a>
            <span className="muted mono nav-email">{account.email}</span>
          </>
        ) : (
          <>
            <a className="nav-link" href="#/login">Sign in</a>
            <a className="btn btn-sm btn-invert" href="#/login">Get started</a>
          </>
        )}
      </nav>
    </header>
  );
}

function Shell({ account, children }: { account: Account | null; children: ReactNode }) {
  return (
    <div className="app">
      <PublicNav account={account} />
      {children}
    </div>
  );
}

function Console({ route, account, onSignOut }: { route: Route; account: Account | null; onSignOut: () => void }) {
  const health = useApi(() => api.health(), []);
  const connected = health.data?.status === "ok";

  return (
    <div className="app">
      <header className="topnav">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="1" y="1" width="7" height="7" rx="2.2" fill="currentColor" /><rect x="10" y="1" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /><rect x="1" y="10" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /><rect x="10" y="10" width="7" height="7" rx="2.2" fill="currentColor" fillOpacity="0.38" /></svg>
          </span>
          podkit
        </a>
        <span className="crumb-sep">/</span>
        <nav className="crumb muted">
          <a href="#/dashboard">cloud</a>
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
        <a className="nav-link" href="#/docs">Docs</a>
        <span className={"status " + (health.loading ? "status-none" : connected ? "status-ready" : "status-error")}>
          <span className="dot" />
          {health.loading ? "connecting" : connected ? "connected" : "offline"}
        </span>
        {account && <span className="muted mono" style={{ fontSize: "var(--t-sm)" }}>{account.email}</span>}
        <button className="btn btn-sm btn-ghost" onClick={onSignOut}>Sign out</button>
      </header>

      {route.page === "cli" ? (
        <CliAuthorize />
      ) : route.page === "project" ? (
        <Project slug={route.slug} />
      ) : (
        <Projects />
      )}
    </div>
  );
}

