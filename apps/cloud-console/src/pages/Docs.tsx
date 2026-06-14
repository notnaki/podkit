// Public documentation — one page, anchor-navigated, covering all three layers
// (CLI, framework, cloud platform). Content is derived from the real source:
//   - CLI: packages/cli/src/bin.ts + commands/*.ts (cloud.ts AVAILABLE/hints,
//     dev/build/start/db/auth/deploy/logs/analytics/docs dispatch).
//   - Framework: packages/framework/src (routing/discover.ts, render/ssr.ts,
//     loader/run.ts, build/app.ts, server/{dev,prod}-server.ts, types.ts).
//   - Cloud platform: packages/cloud-host/src/host.ts (deploy-upload, /_p/<slug>
//     routing, zero-downtime swap, read-only SQL gate, branch DB isolation,
//     token TTLs, env/domains/logs/metrics/rollback/preview).
// All commands/flags below are taken verbatim from those files — nothing invented.

import { useEffect, useState } from "react";

interface Section {
  id: string;
  label: string;
}

const SECTIONS: Section[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "cli-podkit", label: "CLI · podkit" },
  { id: "cli-cloud", label: "CLI · podkit cloud" },
  { id: "framework", label: "Framework" },
  { id: "platform", label: "Cloud platform" },
];

export function Docs() {
  const active = useScrollSpy(SECTIONS.map((s) => s.id));
  return (
    <main className="docs">
      <aside className="docs-side">
        <nav className="docs-nav">
          <span className="docs-nav-title faint mono">Documentation</span>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#/docs`}
              className={"docs-nav-link" + (active === s.id ? " active" : "")}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="docs-body">
        <GettingStarted />
        <CliPodkit />
        <CliCloud />
        <Framework />
        <Platform />
      </article>
    </main>
  );
}

// Highlights the section nearest the top of the viewport. Cheap and dependency-free.
function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const onScroll = () => {
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) current = id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ids.join(",")]);
  return active;
}

function Block({ children }: { children: string }) {
  return <pre className="code docs-code">{children}</pre>;
}

function GettingStarted() {
  return (
    <section id="getting-started" className="docs-section">
      <h1>Getting started</h1>
      <p className="docs-lede">
        podkit is an agents-first app platform: a React framework, a managed
        Postgres per project, and one-command deploys, all driven by a single CLI
        whose every command returns a typed JSON envelope.
      </p>

      <h3>Install</h3>
      <p>
        Clone the repo and install with pnpm. The CLI is the{" "}
        <code>podkit</code> binary in <code>packages/cli</code>.
      </p>
      <Block>{`git clone <your-podkit-repo> && cd podkit
pnpm install

# run the CLI (from a workspace that exposes it)
podkit --help`}</Block>

      <h3>Create an app</h3>
      <p>
        Scaffold a new podkit app — file-based routes, a server loader, and a
        client entry — with one command, then run it locally.
      </p>
      <Block>{`podkit init my-app                 # scaffold ./my-app
cd my-app
podkit dev                         # http://localhost:3000`}</Block>

      <h3>Sign in</h3>
      <p>
        Authorize the CLI against your control-plane. <code>podkit cloud login</code>{" "}
        opens a browser device-code flow: it prints a user code, you enter it on
        the sign-in screen, and the CLI stores the resulting token locally.
      </p>
      <Block>{`podkit cloud login                 # default control-plane (http://localhost:8080)
podkit cloud login --url https://cloud.example.com
podkit cloud whoami                # confirm the active account`}</Block>

      <h3>Deploy</h3>
      <p>
        From inside an app directory, deploy with one command. No Dockerfile or
        config is required — the CLI packages the current directory and the
        control-plane builds a standalone image for you.
      </p>
      <Block>{`podkit cloud create myapp          # provision the project + its database
podkit cloud deploy myapp          # package, upload, build, and go live
podkit cloud open myapp            # open the live URL`}</Block>
      <p className="muted">
        Add <code>--json</code> to any command for machine-legible output, or{" "}
        <code>--quiet</code> to suppress the success line.
      </p>
    </section>
  );
}

function CliPodkit() {
  return (
    <section id="cli-podkit" className="docs-section">
      <h2>CLI reference · <span className="mono">podkit</span></h2>
      <p>
        The local CLI builds and runs podkit apps and manages databases, auth,
        deploys, logs, and analytics. Global flags: <code>--json</code> prints the
        raw envelope, <code>--quiet</code> suppresses the success line.
      </p>

      <table className="table docs-table">
        <thead>
          <tr><th>Command</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td className="mono">podkit dev [--port 3000]</td><td>Start the dev server with SSR over the routes in <code>app/routes</code>.</td></tr>
          <tr><td className="mono">podkit build [--appRoot &lt;dir&gt;] [--outDir &lt;dir&gt;]</td><td>Produce a production build (client + per-route SSR bundles + manifest) under <code>.podkit/build</code>.</td></tr>
          <tr><td className="mono">podkit start [--buildDir &lt;dir&gt;] [--port 3000]</td><td>Serve a build with the production server (no Vite at runtime).</td></tr>
          <tr><td className="mono">podkit db migrate</td><td>Generate a migration from <code>app/db/schema.ts</code> and apply pending migrations.</td></tr>
          <tr><td className="mono">podkit db pull</td><td>Introspect the database and write a migration reflecting the live schema.</td></tr>
          <tr><td className="mono">podkit auth signup --email &lt;e&gt; --password &lt;p&gt;</td><td>Create a local user.</td></tr>
          <tr><td className="mono">podkit auth login --email &lt;e&gt; --password &lt;p&gt;</td><td>Log in locally and mint a session token.</td></tr>
          <tr><td className="mono">podkit auth token --user &lt;id&gt; [--scope &lt;s&gt;]</td><td>Issue an agent token with zero or more scopes.</td></tr>
          <tr><td className="mono">podkit auth whoami --token &lt;t&gt;</td><td>Verify a token and print its identity (incl. <code>isAgent</code>).</td></tr>
          <tr><td className="mono">podkit deploy up</td><td>Build an artifact, publish a version, and promote it (local deploy registry).</td></tr>
          <tr><td className="mono">podkit deploy promote &lt;versionId&gt;</td><td>Promote a published version to current.</td></tr>
          <tr><td className="mono">podkit deploy rollback</td><td>Roll back to the previous version.</td></tr>
          <tr><td className="mono">podkit deploy deployments</td><td>List local versions and the current one.</td></tr>
          <tr><td className="mono">podkit logs [--level &lt;l&gt;] [--route &lt;r&gt;] [--since &lt;ts&gt;]</td><td>Query structured log events from the local telemetry sink.</td></tr>
          <tr><td className="mono">podkit analytics query</td><td>Aggregate telemetry events into counts.</td></tr>
          <tr><td className="mono">podkit docs [topic|project]</td><td>List doc topics, read one, or describe the current project.</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function CliCloud() {
  return (
    <section id="cli-cloud" className="docs-section">
      <h2>CLI reference · <span className="mono">podkit cloud</span></h2>
      <p>
        The <code>cloud</code> commands talk to a control-plane. The active
        control-plane and token come from <code>podkit cloud login</code>;{" "}
        override the URL with <code>--url</code> or <code>PODKIT_API_URL</code>.
        Many list commands accept <code>--table</code> for aligned text output.
      </p>

      <h3>Auth &amp; projects</h3>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td className="mono">login [--url &lt;url&gt;]</td><td>Device-code sign-in; stores the URL + token locally.</td></tr>
          <tr><td className="mono">logout</td><td>Clear the stored credentials.</td></tr>
          <tr><td className="mono">whoami</td><td>Print the authenticated account.</td></tr>
          <tr><td className="mono">projects [--table]</td><td>List your projects (alias: <code>list</code>).</td></tr>
          <tr><td className="mono">create &lt;slug&gt;</td><td>Create a project and provision its database.</td></tr>
          <tr><td className="mono">status &lt;slug&gt; [--table]</td><td>URL, latest deployment, and env/domain counts in one call.</td></tr>
          <tr><td className="mono">url &lt;slug&gt;</td><td>Print the project's live URL.</td></tr>
          <tr><td className="mono">open &lt;slug&gt;</td><td>Open the live URL in a browser.</td></tr>
        </tbody>
      </table>

      <h3>Deploys</h3>
      <p>
        <code>deploy</code> is one-click: from your app directory, run{" "}
        <code>podkit cloud deploy &lt;slug&gt;</code> with no other flags. The CLI
        tars the current directory (excluding <code>node_modules</code>,{" "}
        <code>.git</code>, and <code>.podkit/dist</code>), streams it to the
        control-plane, and the control-plane builds a standalone app — no
        Dockerfile needed. All flags are optional:
      </p>
      <Block>{`podkit cloud deploy <slug>
  [--contextDir=<dir>]        # directory to deploy (default: cwd)
  [--containerPort=3000]      # app port inside the container (default 3000)
  [--appSubpath=apps/myapp]   # monorepo only: path to the app in the tarball`}</Block>
      <p className="muted">
        An explicit Dockerfile in the context always wins (full opt-out of the
        standalone builder).
      </p>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td className="mono">deployments &lt;slug&gt;</td><td>List a project's deployment history (deploy/rollback/preview rows).</td></tr>
          <tr><td className="mono">rollback &lt;slug&gt; &lt;deploymentId&gt;</td><td>Re-promote a previous deployment (zero-downtime).</td></tr>
          <tr><td className="mono">logs &lt;slug&gt;</td><td>Fetch logs for the active deployment.</td></tr>
          <tr><td className="mono">metrics &lt;slug&gt;</td><td>Request counts by status class and average latency.</td></tr>
        </tbody>
      </table>

      <h3>Config: env, domains, branches, preview</h3>
      <Block>{`podkit cloud env set <slug> KEY=VALUE [--sensitive]
podkit cloud env list <slug>
podkit cloud env rm <slug> KEY

podkit cloud domains add <slug> <domain>
podkit cloud domains list <slug>
podkit cloud domains rm <slug> <domain>

podkit cloud branches list <slug>
podkit cloud branches create <slug> <name>     # forks the DB, prints a connection string
podkit cloud branches rm <slug> <name>         # drops the branch DB (confirms first)

podkit cloud preview <slug> <branchName> [--contextDir=<dir>] [--containerPort=<port>]
podkit cloud preview list <slug>`}</Block>
    </section>
  );
}

function Framework() {
  return (
    <section id="framework" className="docs-section">
      <h2>Framework</h2>
      <p className="docs-lede">
        The podkit framework is a small React SSR layer: file-based routing,
        per-route loaders, server rendering with client hydration, and a build
        that compiles each route ahead of time.
      </p>

      <h3>Routing</h3>
      <p>
        Routes are files under <code>app/routes</code>. The path on disk becomes
        the URL: <code>index</code> collapses to its parent segment, files
        starting with <code>_</code> are ignored, and bracketed segments are
        dynamic.
      </p>
      <table className="table docs-table">
        <thead><tr><th>File</th><th>Matches</th><th>Kind</th></tr></thead>
        <tbody>
          <tr><td className="mono">app/routes/index.tsx</td><td className="mono">/</td><td>static</td></tr>
          <tr><td className="mono">app/routes/about.tsx</td><td className="mono">/about</td><td>static</td></tr>
          <tr><td className="mono">app/routes/posts/[slug].tsx</td><td className="mono">/posts/:slug</td><td>dynamic</td></tr>
          <tr><td className="mono">app/routes/docs/[...path].tsx</td><td className="mono">/docs/*path</td><td>catchall</td></tr>
        </tbody>
      </table>

      <h3>Loaders</h3>
      <p>
        Export a <code>loader</code> from a route to fetch data on the server. It
        receives a <code>LoaderContext</code> — route <code>params</code>, the
        request <code>url</code>, and the resolved <code>auth</code> identity (or
        null). Its return value is passed to the page as the <code>data</code> prop
        and serialized for hydration.
      </p>
      <Block>{`// app/routes/posts/[slug].tsx
import type { LoaderContext } from "@podkit/framework";

export async function loader(ctx: LoaderContext) {
  return { slug: ctx.params.slug, viewer: ctx.auth?.userId ?? null };
}

export default function Post({ data }: { data: { slug: string } }) {
  return <h1>{data.slug}</h1>;
}`}</Block>

      <h3>SSR &amp; hydration</h3>
      <p>
        Each route's default export is rendered to HTML on the server with{" "}
        <code>renderToString</code>, embedded in the document alongside its loader
        data, and hydrated on the client from a single shared entry —{" "}
        <code>app/entry-client.tsx</code>.
      </p>

      <h3>Build &amp; serve</h3>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>Behavior</th></tr></thead>
        <tbody>
          <tr><td className="mono">podkit dev</td><td>Dev server with SSR and hot reload over your routes.</td></tr>
          <tr><td className="mono">podkit build</td><td>Vite client build (hashed, manifested) + a pre-compiled SSR module per route, then a build manifest. React stays external to the SSR bundle.</td></tr>
          <tr><td className="mono">podkit start</td><td>Production server that dynamically imports the pre-built SSR modules — no Vite at runtime.</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function Platform() {
  return (
    <section id="platform" className="docs-section">
      <h2>Cloud platform</h2>
      <p className="docs-lede">
        The control-plane hosts your projects: it provisions databases, builds
        uploaded apps, runs them in containers, and routes public traffic through
        a gateway.
      </p>

      <h3>Projects &amp; managed Postgres</h3>
      <p>
        Creating a project provisions an isolated Postgres database with a scoped
        role; the connection string is returned once at create time. Projects are
        owned by the account that creates them, and access is enforced per project.
      </p>

      <h3>One-click deploy</h3>
      <p>
        A deploy streams a gzipped tarball of your app to the control-plane, which
        extracts it under strict path-traversal protection, builds a standalone
        image on a vendored base (or uses your Dockerfile if present), and starts
        a container. The build never buffers the whole upload in memory and is
        capped at a generous size limit.
      </p>

      <h3>Zero-downtime &amp; rollback</h3>
      <p>
        On deploy, the new container is health-checked at the exact address the
        gateway will dial before the route is switched. If it never becomes
        healthy, the route is left untouched and the old version keeps serving —
        the gateway never sees a half-broken route. Rollback re-promotes a prior
        deployment with the same guarantee.
      </p>

      <h3>Preview deploys &amp; DB branching</h3>
      <p>
        Branch a project's database to get an isolated copy with its own scoped
        connection string, then deploy a preview against it. Production serves at{" "}
        <code>/_p/&lt;slug&gt;/</code>; a preview gets its own route key of the
        form <code>&lt;slug&gt;--&lt;branch&gt;</code>, tracked separately from
        production so it never owns the production route. Tear a preview down with{" "}
        <code>preview</code> teardown or remove the branch entirely.
      </p>

      <h3>Env vars, domains, logs &amp; metrics</h3>
      <p>
        Set environment variables (optionally marked sensitive), attach custom
        domains, stream logs for the active deployment, and read request metrics
        — counts by 2xx/3xx/4xx/5xx and average latency — all per project, from
        the CLI or the dashboard.
      </p>

      <h3>Database queries</h3>
      <p>
        The platform exposes a read-only query endpoint guarded by a conservative
        allow/deny gate: only a single <code>SELECT</code> statement is accepted,
        and DML, DDL, multi-statement input, and dangerous builtins are rejected
        before any connection opens. The per-project scoped role remains the real
        isolation boundary.
      </p>

      <h3>Auth &amp; tokens</h3>
      <p>
        Accounts sign in for web sessions (tokens valid ~30 days); CLI and
        automation tokens are longer-lived (~90 days) and revocable. Agent tokens
        carry scopes and an <code>isAgent</code> marker, so agent activity is
        legible everywhere it appears.
      </p>
    </section>
  );
}
