// Public documentation — one page, anchor-navigated, covering the whole stack:
// the framework, the database layer, both CLIs, the REST API, core concepts,
// configuration, self-hosting, and troubleshooting.
//
// Everything here is derived verbatim from the real source — nothing invented —
// because podkit is novel and won't appear in any model's training data:
//   - Framework: packages/framework/src (routing/discover.ts, render/{ssr,document}.ts,
//     loader/run.ts, build/app.ts, server/{dev,prod}-server.ts, types.ts).
//   - Database: packages/db/src (schema.ts, rls/policy.ts, migrations/*, pull.ts).
//   - CLI: packages/cli/src/bin.ts + commands/*.ts; errors.ts (error codes).
//   - Cloud: packages/cloud-host/src/{host.ts,serve.ts}, gateway/src/gateway.ts,
//     cloud-store/src/crypto.ts, db-provision/src/provision.ts, infra/.env.example.
// When the code changes, change this page.

import { useEffect, useState, type ReactNode } from "react";

interface Section {
  id: string;
  label: string;
}

const SECTIONS: Section[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "tutorial", label: "Tutorial" },
  { id: "framework", label: "Framework" },
  { id: "database", label: "Database" },
  { id: "cli-podkit", label: "CLI · podkit" },
  { id: "cli-cloud", label: "CLI · podkit cloud" },
  { id: "api", label: "REST API" },
  { id: "concepts", label: "Concepts" },
  { id: "config", label: "Configuration" },
  { id: "self-hosting", label: "Self-hosting" },
  { id: "troubleshooting", label: "Troubleshooting" },
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
              href="#/docs"
              className={"docs-nav-link" + (active === s.id ? " active" : "")}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(s.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="docs-body">
        <GettingStarted />
        <Tutorial />
        <Framework />
        <Database />
        <CliPodkit />
        <CliCloud />
        <Api />
        <Concepts />
        <Config />
        <SelfHosting />
        <Troubleshooting />
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

function Note({ children }: { children: ReactNode }) {
  return <div className="docs-note">{children}</div>;
}

function M({ children }: { children: string }) {
  return <span className={"docs-method m-" + children.toLowerCase()}>{children}</span>;
}

function GettingStarted() {
  return (
    <section id="getting-started" className="docs-section">
      <h1>Getting started</h1>
      <p className="docs-lede">
        podkit is an agents-first app platform: a small React SSR framework, a
        managed Postgres per project, and one-command deploys — all driven by a
        single CLI whose every command returns a typed JSON envelope.
      </p>

      <h3>Install</h3>
      <p>
        podkit isn't published to npm yet. Clone the repo and install with pnpm;
        the CLI is the <code>podkit</code> binary in <code>packages/cli</code>.
      </p>
      <Block>{`git clone https://github.com/notnaki/podkit && cd podkit
pnpm install
podkit --help`}</Block>

      <h3>Create an app</h3>
      <p>
        Scaffold a new app — file-based routes, a typed server loader, and a
        client entry — with one command, then run it locally.
      </p>
      <Block>{`podkit init my-app     # scaffold ./my-app
cd my-app
podkit dev             # http://localhost:3000`}</Block>
      <Note>
        Until the packages are on npm, create apps inside a podkit checkout (e.g.
        under <code>examples/</code> or <code>apps/</code>) so <code>@podkit/*</code>{" "}
        resolve as workspace packages. Deploys work either way — the cloud builds
        on a base image that already includes the framework.
      </Note>

      <h3>Sign in &amp; deploy</h3>
      <p>
        Authorize the CLI against a control-plane with a browser device-code
        flow, then deploy with no Dockerfile, port, or path.
      </p>
      <Block>{`podkit cloud login           # default control-plane http://localhost:8080
podkit cloud create my-app   # provision the project + its database
podkit cloud deploy my-app   # package, upload, build, health-check, go live
podkit cloud open my-app     # open the live URL`}</Block>
      <p className="muted">
        Add <code>--json</code> to any command for the raw envelope, or{" "}
        <code>--quiet</code> to suppress the success line.
      </p>
    </section>
  );
}

function Tutorial() {
  return (
    <section id="tutorial" className="docs-section">
      <h2>Tutorial — from zero to deployed</h2>
      <p className="docs-lede">
        A complete pass: scaffold an app, add a dynamic route with a typed
        loader, set an environment variable, and ship it.
      </p>

      <h3>1 · Scaffold and run</h3>
      <Block>{`podkit init blog && cd blog
pnpm install
podkit dev   # open http://localhost:3000`}</Block>
      <p>
        The scaffold gives you <code>app/routes/index.tsx</code> (with a loader),
        <code>app/routes/about.tsx</code>, and a shared{" "}
        <code>app/entry-client.tsx</code>.
      </p>

      <h3>2 · Add a dynamic route with a typed loader</h3>
      <p>
        Create <code>app/routes/posts/[slug].tsx</code>. The bracketed segment is
        a dynamic param; <code>PageProps&lt;LoaderData&lt;typeof loader&gt;&gt;</code>{" "}
        keeps the component's <code>data</code> in lockstep with the loader.
      </p>
      <Block>{`// app/routes/posts/[slug].tsx
import type { LoaderContext, PageProps, LoaderData } from "@podkit/framework";

export async function loader(ctx: LoaderContext) {
  return {
    slug: ctx.params.slug,
    viewer: ctx.auth?.userId ?? null, // null when unauthenticated
  };
}

export default function Post({ data }: PageProps<LoaderData<typeof loader>>) {
  return (
    <main>
      <h1>{data.slug}</h1>
      {data.viewer ? <p>Signed in as {data.viewer}</p> : <p>Guest</p>}
    </main>
  );
}`}</Block>
      <p className="muted">
        Visit <code>/posts/hello</code>. <code>ctx.params.slug</code> is{" "}
        <code>"hello"</code>; the loader runs on the server and its return value
        is passed to the component as <code>data</code>.
      </p>

      <h3>3 · Build &amp; serve a production bundle locally</h3>
      <Block>{`podkit build   # client bundle + per-route SSR modules + manifest in .podkit/build
podkit start   # production server, no Vite at runtime`}</Block>

      <h3>4 · Deploy</h3>
      <Block>{`podkit cloud login
podkit cloud create blog
podkit cloud env set blog SITE_NAME="My Blog"
podkit cloud deploy blog
podkit cloud open blog`}</Block>
      <p>
        That's the whole loop. From here, add a database (
        <a
          href="#/docs"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("database")?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          Database
        </a>
        ), branch it for staging (
        <a
          href="#/docs"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("concepts")?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          Concepts
        </a>
        ), or attach a custom domain.
      </p>
    </section>
  );
}

function Framework() {
  return (
    <section id="framework" className="docs-section">
      <h2>Framework</h2>
      <p className="docs-lede">
        The podkit framework is a small React SSR layer: file-based routing,
        per-route server loaders, server rendering with client hydration, and a
        build that compiles each route ahead of time. You import only{" "}
        <em>types</em> from <code>@podkit/framework</code> in app code; the
        functions below are the toolchain the CLI drives for you.
      </p>

      <h3>Project layout</h3>
      <Block>{`my-app/
  app/
    routes/            # file-based routes (URL = path on disk)
      index.tsx        # "/"
      about.tsx        # "/about"
      posts/[slug].tsx # "/posts/:slug"  (dynamic)
      docs/[...path].tsx # "/docs/*"      (catch-all)
    entry-client.tsx   # shared client entry (hydrates the server markup)
    db/                # optional: schema.ts + migrations/ (see Database)
  package.json         # scripts: podkit dev | build | start
  .podkit/             # build output, local telemetry (gitignored)`}</Block>

      <h3>Routing</h3>
      <p>
        Routes are files under <code>app/routes</code>. The path on disk becomes
        the URL: <code>index</code> collapses to its parent segment, files
        starting with <code>_</code> are ignored, bracketed segments are dynamic,
        and <code>[...name]</code> is a catch-all. Matches are ranked{" "}
        <strong>static &gt; dynamic &gt; catch-all</strong>.
      </p>
      <table className="table docs-table">
        <thead>
          <tr><th>File</th><th>Matches</th><th>Kind</th><th>params</th></tr>
        </thead>
        <tbody>
          <tr><td className="mono">app/routes/index.tsx</td><td className="mono">/</td><td>static</td><td>—</td></tr>
          <tr><td className="mono">app/routes/about.tsx</td><td className="mono">/about</td><td>static</td><td>—</td></tr>
          <tr><td className="mono">app/routes/posts/[slug].tsx</td><td className="mono">/posts/:slug</td><td>dynamic</td><td className="mono">slug</td></tr>
          <tr><td className="mono">app/routes/docs/[...path].tsx</td><td className="mono">/docs/*</td><td>catch-all</td><td className="mono">path</td></tr>
          <tr><td className="mono">app/routes/_layout.tsx</td><td className="muted">(wraps all routes)</td><td>layout</td><td>—</td></tr>
          <tr><td className="mono">app/routes/_helper.tsx</td><td className="muted">(ignored)</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
      <p>
        A <code>_layout.tsx</code> wraps the routes beside and below it:{" "}
        <code>app/routes/_layout.tsx</code> wraps everything, a{" "}
        <code>&lt;dir&gt;/_layout.tsx</code> wraps that directory's routes nested
        inside the root layout. A layout is a presentational component that
        receives the page as <code>children</code> (plus the route's loader{" "}
        <code>data</code>) — use it for shared chrome like nav and footers.
      </p>

      <h3>Loaders</h3>
      <p>
        Export a <code>loader</code> from a route to fetch data on the server. It
        receives a <code>LoaderContext</code> and returns any JSON-serializable
        value, which becomes the page's <code>data</code> prop.
      </p>
      <h3>Actions</h3>
      <p>
        Export an <code>action</code> to handle writes. It runs on non-GET
        requests (typically a form <code>POST</code>), receives an{" "}
        <code>ActionContext</code> with parsed <code>formData</code> alongside{" "}
        <code>params</code>/<code>url</code>/<code>auth</code>, and returns an{" "}
        <code>ActionResult</code> — a redirect, answered as a 303
        Post/Redirect/Get, optionally setting <code>cookies</code>. Routes with no{" "}
        <code>action</code> return <code>405</code> for non-GET requests.
      </p>
      <Block>{`interface LoaderContext {
  params: Record<string, string>;            // dynamic route params
  url: URL;                                   // the full request URL
  auth?: { userId: string; isAgent: boolean } | null; // verified principal, or null
}

// Type helpers (pure types — erased at build time):
interface PageProps<T> { data: T; }
type LoaderData<L> = L extends (...a: never[]) => infer R
  ? Awaited<R>
  : Record<string, never>; // a route with no loader receives {}`}</Block>
      <p>
        <code>auth</code> is resolved from an <code>Authorization: Bearer</code>{" "}
        header or a <code>podkit_session</code> cookie, verified with{" "}
        <code>PODKIT_AUTH_SECRET</code>. It is <code>null</code> when there is no
        valid token — always handle that case.
      </p>

      <h3>SSR</h3>
      <p>
        On each request the matched route's default export — wrapped in its
        layout chain — is rendered to HTML with React's{" "}
        <code>renderToString</code> and the loader data is embedded on{" "}
        <code>window.__PODKIT_DATA__</code>. Data is JSON-serialized, so loader
        return values must be JSON-safe. The current model is prop-based SSR:
        components receive their data as the <code>data</code> prop, and writes go
        through <code>action</code> form posts. (Full client hydration —
        re-mounting components for client interactivity — is on the roadmap; the
        scaffolded <code>app/entry-client.tsx</code> is a no-op until then.)
      </p>

      <h3>Build &amp; serve</h3>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>Behavior</th></tr></thead>
        <tbody>
          <tr><td className="mono">podkit dev</td><td>Vite dev server with SSR and hot reload over your routes.</td></tr>
          <tr><td className="mono">podkit build</td><td>Vite client build (hashed + manifested) plus a pre-compiled SSR module per route, then a <code>build-manifest.json</code>. React stays external to the SSR bundle.</td></tr>
          <tr><td className="mono">podkit start</td><td>Production server that dynamically imports the pre-built SSR modules — no Vite at runtime.</td></tr>
        </tbody>
      </table>

      <h3>Framework API (toolchain)</h3>
      <p className="muted">
        Exported from <code>@podkit/framework</code>; used by the CLI/build, not
        usually by app code.
      </p>
      <table className="table docs-table">
        <thead><tr><th>Export</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td className="mono">buildRouteTable(files)</td><td>Discover a route table from file paths.</td></tr>
          <tr><td className="mono">matchRoute(table, pathname)</td><td>Match a URL to a route + params (ranked static &gt; dynamic &gt; catch-all).</td></tr>
          <tr><td className="mono">runLoader(mod, ctx)</td><td>Run a route module's loader (returns <code>{`{}`}</code> if none).</td></tr>
          <tr><td className="mono">renderPage(mod, data, clientEntry)</td><td>Server-render a route module to a full HTML document.</td></tr>
          <tr><td className="mono">createDevServer(opts)</td><td>Dev server (Vite middleware, HMR, SSR).</td></tr>
          <tr><td className="mono">createProdServer(opts)</td><td>Production server over a build directory.</td></tr>
          <tr><td className="mono">buildApp(appRoot, outDir)</td><td>Produce the client bundle, SSR modules, and manifest.</td></tr>
          <tr><td className="mono">readManifest / writeManifest</td><td>Read/write the build manifest.</td></tr>
          <tr><td className="mono">Route, RouteKind, LoaderContext, PageProps, LoaderData</td><td>Public types.</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function Database() {
  return (
    <section id="database" className="docs-section">
      <h2>Database</h2>
      <p className="docs-lede">
        podkit treats your schema as code via <code>@podkit/db</code>. You define
        tables in TypeScript, derive migrations from them, and (optionally) attach
        row-level security policies. In the cloud, every project gets its own
        isolated Postgres database.
      </p>

      <h3>Schema as code</h3>
      <p>
        Define tables in <code>app/db/schema.ts</code> using helpers re-exported
        from <code>@podkit/db</code>.
      </p>
      <Block>{`// app/db/schema.ts
import { pgTable, uuidPk, text, timestamp } from "@podkit/db";

export const posts = pgTable("posts", {
  id: uuidPk(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});`}</Block>
      <p>
        Available helpers: <code>pgTable</code>, <code>uuid</code>,{" "}
        <code>uuidPk</code>, <code>text</code>, <code>integer</code>,{" "}
        <code>boolean</code>, <code>timestamp</code>, <code>jsonb</code>.
      </p>

      <h3>Migrations</h3>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td className="mono">podkit db migrate</td><td>Generate a migration from <code>app/db/schema.ts</code> and apply pending migrations (idempotent; tolerates "no schema changes").</td></tr>
          <tr><td className="mono">podkit db pull</td><td>Introspect the live database and write it back to code — a SQL migration plus a regenerated drizzle <code>schema.ts</code> — for adopting an existing database.</td></tr>
        </tbody>
      </table>

      <h3>Row-level security (RLS)</h3>
      <p>
        <code>@podkit/db</code> ships helpers that emit Postgres policy SQL keyed
        on settings podkit binds from the verified principal —{" "}
        <code>current_setting('podkit.user_id')</code>,{" "}
        <code>podkit.org_id</code>, and <code>podkit.is_agent</code>.
      </p>
      <Block>{`import { enableRls, ownedBy, isAgent } from "@podkit/db";

enableRls("posts");                 // ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;
ownedBy("posts", "author_id");      // rows where author_id = current podkit.user_id
isAgent("audit_log");               // visible only to agent tokens
// also: inOrg(table, column), customPolicy(table, name, usingExpr)`}</Block>

      <h3>Managed Postgres in the cloud</h3>
      <p>
        Creating a project provisions a dedicated database named{" "}
        <code>proj_&lt;slug&gt;</code> with a scoped, <strong>non-superuser</strong>{" "}
        role that owns only that database. The connection string is returned once,
        at create time, and injected into your app as <code>DATABASE_URL</code> on
        deploy. <code>PUBLIC CONNECT</code> is revoked, so tenants are isolated at
        the role level — underneath any RLS you add. Branch a database for staging
        or previews; see <em>Concepts</em>.
      </p>
      <Note>
        The cloud also exposes a guarded read-only SQL endpoint (
        <code>POST /v1/projects/:slug/db/query</code>): a single <code>SELECT</code>{" "}
        only, no DML/DDL/multi-statement/dangerous builtins, auto-<code>LIMIT 1000</code>,
        a 5s statement timeout, run as the scoped role. See REST API.
      </Note>
    </section>
  );
}

function CliPodkit() {
  return (
    <section id="cli-podkit" className="docs-section">
      <h2>CLI reference · <span className="mono">podkit</span></h2>
      <p>
        The local CLI builds and runs podkit apps and manages databases, auth,
        local deploys, logs, and analytics. Global flags: <code>--json</code>{" "}
        prints the raw envelope, <code>--quiet</code> suppresses the success line.
        Every command exits non-zero on failure with a structured error.
      </p>

      <table className="table docs-table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td className="mono">podkit init [name]</td><td>Scaffold a new app (<code>.</code> or omitted = current dir; name must be slug-safe).</td></tr>
          <tr><td className="mono">podkit dev [--port 3000]</td><td>Dev server with SSR and hot reload over <code>app/routes</code>.</td></tr>
          <tr><td className="mono">podkit build [--appRoot &lt;dir&gt;] [--outDir &lt;dir&gt;]</td><td>Production build (client + per-route SSR + manifest) under <code>.podkit/build</code>.</td></tr>
          <tr><td className="mono">podkit start [--buildDir &lt;dir&gt;] [--port 3000]</td><td>Serve a build with the production server (no Vite).</td></tr>
          <tr><td className="mono">podkit db migrate</td><td>Generate + apply migrations from <code>app/db/schema.ts</code>.</td></tr>
          <tr><td className="mono">podkit db pull</td><td>Introspect the database into a migration + regenerated <code>schema.ts</code>.</td></tr>
          <tr><td className="mono">podkit auth signup --email &lt;e&gt; --password &lt;p&gt;</td><td>Create a local user.</td></tr>
          <tr><td className="mono">podkit auth login --email &lt;e&gt; --password &lt;p&gt;</td><td>Log in locally; mint a session token.</td></tr>
          <tr><td className="mono">podkit auth token --user &lt;id&gt; [--scope &lt;s&gt;]…</td><td>Issue an agent token with zero or more scopes.</td></tr>
          <tr><td className="mono">podkit auth whoami --token &lt;t&gt;</td><td>Verify a token; print identity (incl. <code>isAgent</code>).</td></tr>
          <tr><td className="mono">podkit logs [--level &lt;l&gt;] [--route &lt;r&gt;] [--since &lt;ts&gt;]</td><td>Query structured log events from the local telemetry sink.</td></tr>
          <tr><td className="mono">podkit analytics query</td><td>Aggregate telemetry events into counts.</td></tr>
          <tr><td className="mono">podkit docs [topic|project]</td><td>List doc topics, read one, or describe the current project.</td></tr>
        </tbody>
      </table>
      <p className="muted">
        Doc topics available offline via <code>podkit docs &lt;topic&gt;</code>:{" "}
        <code>routing</code>, <code>db</code>, <code>auth</code>,{" "}
        <code>deploy</code>, <code>cli</code>, <code>cloud</code>,{" "}
        <code>branches</code>, <code>env</code>.
      </p>
    </section>
  );
}

function CliCloud() {
  return (
    <section id="cli-cloud" className="docs-section">
      <h2>CLI reference · <span className="mono">podkit cloud</span></h2>
      <p>
        The <code>cloud</code> commands talk to a control-plane. The active
        control-plane and token come from <code>podkit cloud login</code>;
        override the URL with <code>--url</code> or <code>PODKIT_API_URL</code>.
        Without a token, commands fall back to the <code>PODKIT_API_KEY</code>{" "}
        machine key. Many list commands accept <code>--table</code> for aligned
        text output.
      </p>

      <h3>Auth &amp; projects</h3>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td className="mono">login [--url &lt;url&gt;]</td><td>Device-code sign-in; stores URL + token in <code>~/.podkit/auth.json</code> (mode 0600).</td></tr>
          <tr><td className="mono">logout</td><td>Clear the stored credentials.</td></tr>
          <tr><td className="mono">whoami</td><td>Print the authenticated account.</td></tr>
          <tr><td className="mono">projects [--table]</td><td>List your projects (alias: <code>list</code>).</td></tr>
          <tr><td className="mono">create &lt;slug&gt;</td><td>Create a project and provision its database.</td></tr>
          <tr><td className="mono">status &lt;slug&gt; [--table]</td><td>URL, latest deployment, env/domain counts in one call.</td></tr>
          <tr><td className="mono">url &lt;slug&gt; · open &lt;slug&gt;</td><td>Print / open the project's live URL.</td></tr>
        </tbody>
      </table>

      <h3>Deploys</h3>
      <p>
        <code>deploy</code> is one-click: from your app directory, run{" "}
        <code>podkit cloud deploy &lt;slug&gt;</code> with no other flags. The CLI
        tars the current directory (excluding <code>node_modules</code>,{" "}
        <code>.git</code>, <code>.podkit/dist</code>), streams it to the
        control-plane, and the control-plane builds a standalone image — no
        Dockerfile needed. All flags are optional:
      </p>
      <Block>{`podkit cloud deploy <slug>
  [--contextDir=<dir>]        # directory to deploy (default: cwd)
  [--containerPort=3000]      # app port inside the container (default 3000)
  [--appSubpath=apps/myapp]   # monorepo only: path to the app inside the tarball`}</Block>
      <p className="muted">
        An explicit <code>Dockerfile</code> in the context always wins (full
        opt-out of the standalone builder).
      </p>
      <table className="table docs-table">
        <thead><tr><th>Command</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td className="mono">deployments &lt;slug&gt;</td><td>List deployment history (deploy/rollback/preview/stopped rows; the active one is flagged).</td></tr>
          <tr><td className="mono">rollback &lt;slug&gt; &lt;deploymentId&gt;</td><td>Re-promote a previous deployment (zero-downtime).</td></tr>
          <tr><td className="mono">logs &lt;slug&gt;</td><td>Fetch container logs for the active deployment.</td></tr>
          <tr><td className="mono">metrics &lt;slug&gt;</td><td>Request counts by status class + average latency.</td></tr>
        </tbody>
      </table>

      <h3>Env, domains, branches, previews</h3>
      <Block>{`podkit cloud env set <slug> KEY=VALUE [--sensitive]   # --sensitive = encrypted at rest
podkit cloud env list <slug>
podkit cloud env rm <slug> KEY

podkit cloud domains add <slug> <domain>
podkit cloud domains list <slug>
podkit cloud domains rm <slug> <domain>

podkit cloud branches create <slug> <name>   # forks the DB; prints a connection string
podkit cloud branches list <slug>
podkit cloud branches rm <slug> <name>        # drops the branch DB (confirms first)

podkit cloud preview <slug> <branchName> [--contextDir=<dir>] [--containerPort=<port>]
podkit cloud preview list <slug>`}</Block>
    </section>
  );
}

function Api() {
  return (
    <section id="api" className="docs-section">
      <h2>REST API</h2>
      <p className="docs-lede">
        The control-plane serves a JSON API at <code>/v1/*</code> on port 8080.
        Every response is an envelope: <code>{`{ ok: true, data }`}</code> or{" "}
        <code>{`{ ok: false, error: { code, message, hint } }`}</code>.
      </p>
      <p>
        Authenticate with <code>Authorization: Bearer &lt;token&gt;</code> (account
        or CLI token) or the <code>x-podkit-key</code> machine key. The machine key
        sees all projects and is exempt from per-account quotas; a bearer token
        only sees projects it owns. All <code>/v1/*</code> routes are rate-limited
        per credential/IP.
      </p>

      <h3>Auth</h3>
      <table className="table docs-table api-table">
        <thead><tr><th>Endpoint</th><th>Auth</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><M>POST</M> <code>/v1/auth/signup</code></td><td>public</td><td>Create account → token (30d) + account.</td></tr>
          <tr><td><M>POST</M> <code>/v1/auth/login</code></td><td>public</td><td>Log in → token (30d) + account.</td></tr>
          <tr><td><M>GET</M> <code>/v1/auth/me</code></td><td>bearer</td><td>Current account.</td></tr>
          <tr><td><M>POST</M> <code>/v1/auth/logout</code></td><td>bearer</td><td>Revoke the presented token (by <code>jti</code>).</td></tr>
          <tr><td><M>POST</M> <code>/v1/auth/cli/start</code></td><td>public</td><td>Begin CLI device flow → deviceCode/userCode/verifyUrl.</td></tr>
          <tr><td><M>POST</M> <code>/v1/auth/cli/poll</code></td><td>public</td><td>Poll for an approved CLI token (90d).</td></tr>
          <tr><td><M>POST</M> <code>/v1/auth/cli/approve</code></td><td>bearer</td><td>Approve a device userCode (rate-limited 10/min).</td></tr>
        </tbody>
      </table>

      <h3>Projects &amp; deployments</h3>
      <table className="table docs-table api-table">
        <thead><tr><th>Endpoint</th><th>Auth</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><M>GET</M> <code>/v1/projects</code></td><td>bearer / key</td><td>List projects (owned, or all for key).</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects</code></td><td>bearer / key</td><td>Create project + provision DB (quota: <code>E_QUOTA</code>).</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug</code></td><td>bearer</td><td>Project details + latest deployment + URL.</td></tr>
          <tr><td><M>DELETE</M> <code>/v1/projects/:slug</code></td><td>bearer</td><td>Delete project: stop containers, drop DB + branches + routes.</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/deploy</code></td><td>bearer</td><td>Deploy from a server-local path.</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/deploy-upload</code></td><td>bearer</td><td>Deploy from a streamed gzip tarball (≤500 MiB).</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/deploy-branch</code></td><td>bearer</td><td>Deploy a preview against a branch.</td></tr>
          <tr><td><M>DELETE</M> <code>/v1/projects/:slug/preview/:branch</code></td><td>bearer</td><td>Tear down a preview.</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug/deployments</code></td><td>bearer</td><td>Deployment history (active one flagged).</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/rollback</code></td><td>bearer</td><td>Re-promote a prior deployment (zero-downtime).</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug/logs</code></td><td>bearer</td><td>Container logs (<code>?limit</code>, <code>?since</code>, <code>?deploymentId</code>).</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug/metrics</code></td><td>bearer</td><td>In-process request counts + latency (resets on restart).</td></tr>
        </tbody>
      </table>

      <h3>Config: env, domains, branches, DB</h3>
      <table className="table docs-table api-table">
        <thead><tr><th>Endpoint</th><th>Auth</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/env</code></td><td>bearer</td><td>Set an env var (<code>sensitive</code> → encrypted).</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug/env</code></td><td>bearer</td><td>List env vars (sensitive values null).</td></tr>
          <tr><td><M>DELETE</M> <code>/v1/projects/:slug/env/:key</code></td><td>bearer</td><td>Delete an env var.</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/domains</code></td><td>bearer</td><td>Attach a custom domain.</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug/domains</code></td><td>bearer</td><td>List domains.</td></tr>
          <tr><td><M>DELETE</M> <code>/v1/projects/:slug/domains/:domain</code></td><td>bearer</td><td>Remove a domain.</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/branches</code></td><td>bearer</td><td>Create a branch DB (returns a scoped conn string once).</td></tr>
          <tr><td><M>GET</M> <code>/v1/projects/:slug/branches</code></td><td>bearer</td><td>List branches (no secrets).</td></tr>
          <tr><td><M>DELETE</M> <code>/v1/projects/:slug/branches/:name</code></td><td>bearer</td><td>Drop a branch DB + role.</td></tr>
          <tr><td><M>POST</M> <code>/v1/projects/:slug/db/query</code></td><td>bearer</td><td>Read-only SQL (single <code>SELECT</code>, params <code>$1..$N</code>, auto <code>LIMIT 1000</code>).</td></tr>
        </tbody>
      </table>

      <h3>Gateway</h3>
      <p>
        A separate proxy on port 8090 serves app traffic. Every project is
        reachable at <code>&lt;slug&gt;.&lt;apps-domain&gt;</code> (served at the
        root) and previews at{" "}
        <code>&lt;slug&gt;--&lt;branch&gt;.&lt;apps-domain&gt;</code>, where the apps
        domain is <code>PODKIT_APPS_DOMAIN</code> (defaults to <code>localhost</code>,
        so <code>&lt;slug&gt;.localhost</code> resolves in dev). The path form{" "}
        <code>/_p/&lt;slug&gt;/…</code> also works, and custom domains route by{" "}
        <code>Host</code> header. Unrouted hosts return <code>502 E_NO_ROUTE</code>;
        upstream failures return <code>502 E_UPSTREAM</code> (the real error is
        logged server-side, never leaked).
      </p>
    </section>
  );
}

function Concepts() {
  return (
    <section id="concepts" className="docs-section">
      <h2>Concepts</h2>

      <h3>Managed Postgres &amp; tenant isolation</h3>
      <p>
        Each project gets its own database (<code>proj_&lt;slug&gt;</code>) owned
        by a dedicated <strong>non-superuser</strong> role. <code>PUBLIC CONNECT</code>{" "}
        is revoked and only that role may connect, so projects can't reach each
        other's data. The read-only query endpoint runs as this scoped role too —
        never as an admin.
      </p>

      <h3>Database branching &amp; preview deploys</h3>
      <p>
        A branch is a <code>CREATE DATABASE … WITH TEMPLATE</code> fork with its
        own scoped role and connection string; after cloning, ownership of copied
        objects is reassigned to the branch role. A preview deploy runs against a
        branch under the route key <code>&lt;slug&gt;--&lt;branch&gt;</code>,
        tracked separately from production, and receives the branch's connection
        string as <code>DATABASE_URL</code>. Previews never own the production
        route.
      </p>

      <h3>Zero-downtime deploys &amp; rollback</h3>
      <p>
        On deploy, the new container is health-checked at the exact address the
        gateway will dial <em>before</em> the route is switched. If it never
        becomes healthy, the route is left untouched and the old version keeps
        serving. Rollback re-promotes a prior deployment from its immutable image
        (<code>podkit-&lt;slug&gt;:&lt;version&gt;</code>) with the same guarantee.
      </p>

      <h3>Secrets at rest</h3>
      <p>
        Sensitive env vars and every stored database connection string are
        encrypted with <strong>AES-256-GCM</strong> under{" "}
        <code>PODKIT_SECRETS_KEY</code>, stored as <code>enc:v1:&lt;base64(iv|tag|ciphertext)&gt;</code>.
        Legacy plaintext values are read transparently, so the key can be adopted
        without a migration.
      </p>

      <h3>Auth &amp; tokens</h3>
      <p>
        Account tokens (web sessions) last ~30 days; CLI/automation tokens last
        ~90 days. Both are HMAC-signed, carry a <code>jti</code>, and are revocable
        via <code>logout</code> (checked on every request). Agent tokens carry an{" "}
        <code>isAgent</code> marker and scopes, so agent activity is legible
        wherever it appears.
      </p>

      <h3>Abuse caps</h3>
      <p>
        Two caps protect a shared deployment.{" "}
        <strong>Per-account project quota</strong> (
        <code>PODKIT_MAX_PROJECTS_PER_ACCOUNT</code>, 0 = unlimited) returns{" "}
        <code>403 E_QUOTA</code> on create past the limit; the machine key is
        exempt. <strong>API rate limiting</strong> (
        <code>PODKIT_RATE_LIMIT_PER_MIN</code>, default 600, ≤0 disables) returns{" "}
        <code>429 E_RATE_LIMITED</code>, keyed per credential or IP over a 60s
        window.
      </p>
    </section>
  );
}

function Config() {
  return (
    <section id="config" className="docs-section">
      <h2>Configuration</h2>
      <p className="docs-lede">
        Every knob is an environment variable. The CLI reads a few; the
        control-plane reads the rest.
      </p>

      <h3>CLI</h3>
      <table className="table docs-table">
        <thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td className="mono">PODKIT_API_URL</td><td className="mono">http://localhost:8080</td><td>Control-plane base URL (overridden by stored login URL / <code>--url</code>).</td></tr>
          <tr><td className="mono">PODKIT_API_KEY</td><td className="muted">—</td><td>Machine key (<code>x-podkit-key</code>) when no login token is present.</td></tr>
          <tr><td className="mono">PODKIT_AUTH_FILE</td><td className="mono">~/.podkit/auth.json</td><td>Where login credentials are stored.</td></tr>
          <tr><td className="mono">PODKIT_AUTH_SECRET</td><td className="mono">podkit-dev-secret</td><td>HMAC secret for local <code>podkit auth</code> (required in production).</td></tr>
          <tr><td className="mono">PODKIT_APP_PORT</td><td className="mono">3000</td><td>Default container port for <code>cloud deploy</code>/<code>preview</code>.</td></tr>
          <tr><td className="mono">PODKIT_APPS_DOMAIN</td><td className="mono">localhost</td><td>Wildcard domain for clean per-project URLs (<code>&lt;slug&gt;.&lt;domain&gt;</code>); point at a wildcard-DNS domain in prod.</td></tr>
        </tbody>
      </table>

      <h3>Control-plane</h3>
      <table className="table docs-table">
        <thead><tr><th>Variable</th><th>Default</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td className="mono">PODKIT_CP_DATABASE_URL</td><td className="muted">required</td><td>Control-plane's own Postgres (superuser).</td></tr>
          <tr><td className="mono">PODKIT_ADMIN_DATABASE_URL</td><td className="mono">= CP url</td><td>Admin role used to provision project databases.</td></tr>
          <tr><td className="mono">PODKIT_AUTH_SECRET</td><td className="muted">required (prod)</td><td>HMAC secret for bearer tokens (64 hex chars).</td></tr>
          <tr><td className="mono">PODKIT_SECRETS_KEY</td><td className="muted">required (prod)</td><td>AES-256-GCM key for secrets at rest (64 hex chars).</td></tr>
          <tr><td className="mono">PODKIT_API_KEY</td><td className="muted">—</td><td>Machine key for full, non-account access.</td></tr>
          <tr><td className="mono">PODKIT_API_PORT</td><td className="mono">8080</td><td>API + console port.</td></tr>
          <tr><td className="mono">PODKIT_GATEWAY_PORT</td><td className="mono">8090</td><td>Gateway (app traffic) port.</td></tr>
          <tr><td className="mono">PODKIT_CONSOLE_URL</td><td className="muted">—</td><td>Public console URL (used in CLI verify links).</td></tr>
          <tr><td className="mono">PODKIT_CONSOLE_DIR</td><td className="muted">—</td><td>Directory of built console assets to serve.</td></tr>
          <tr><td className="mono">PODKIT_CORS_ORIGINS</td><td className="mono">* (any)</td><td>Comma-separated allowed browser origins.</td></tr>
          <tr><td className="mono">PODKIT_BASE_IMAGE</td><td className="mono">podkit-base:latest</td><td>Base image standalone builds build FROM.</td></tr>
          <tr><td className="mono">PODKIT_APP_NETWORK</td><td className="muted">—</td><td>Docker network for app containers (container-name routing).</td></tr>
          <tr><td className="mono">PODKIT_BUILDS_ROOT</td><td className="muted">—</td><td>Optional sandbox confining allowed build contexts.</td></tr>
          <tr><td className="mono">PODKIT_MAX_PROJECTS_PER_ACCOUNT</td><td className="mono">0</td><td>Per-account project quota (0 = unlimited).</td></tr>
          <tr><td className="mono">PODKIT_RATE_LIMIT_PER_MIN</td><td className="mono">600</td><td>API requests/min per credential or IP (≤0 disables).</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function SelfHosting() {
  return (
    <section id="self-hosting" className="docs-section">
      <h2>Self-hosting</h2>
      <p className="docs-lede">
        The control-plane ships as a Docker Compose stack. It needs a Docker
        daemon (it builds and runs your apps as containers) and Postgres.
      </p>

      <h3>1 · Generate secrets</h3>
      <Block>{`cp infra/.env.example infra/.env
# Fill these in infra/.env (generate keys with: openssl rand -hex 32)
#   POSTGRES_PASSWORD=
#   PODKIT_AUTH_SECRET=     # 64 hex chars
#   PODKIT_SECRETS_KEY=     # 64 hex chars
#   PODKIT_API_KEY=         # long random value`}</Block>

      <h3>2 · Bring it up</h3>
      <Block>{`docker compose -f infra/docker-compose.prod.yml --env-file infra/.env up -d --build`}</Block>
      <p>
        This starts Postgres, the control-plane (API + console on <code>:8080</code>),
        and the gateway (<code>:8090</code>). App containers join a shared{" "}
        <code>podkit</code> Docker network so the gateway can reach them by
        container name.
      </p>

      <h3>3 · Point the CLI at it</h3>
      <Block>{`podkit cloud login --url https://cloud.example.com`}</Block>

      <Note>
        For a public deployment, front <code>:8080</code> and <code>:8090</code>{" "}
        with a TLS-terminating reverse proxy, set <code>PODKIT_CONSOLE_URL</code>{" "}
        and <code>PODKIT_CORS_ORIGINS</code>, and turn on the abuse caps
        (<code>PODKIT_MAX_PROJECTS_PER_ACCOUNT</code>,{" "}
        <code>PODKIT_RATE_LIMIT_PER_MIN</code>). See{" "}
        <code>docs/DEPLOY.md</code> in the repo for the full runbook.
      </Note>
    </section>
  );
}

function Troubleshooting() {
  return (
    <section id="troubleshooting" className="docs-section">
      <h2>Troubleshooting</h2>

      <h3>Error codes</h3>
      <p>
        CLI failures print a structured error <code>{`{ code, message, hint }`}</code>{" "}
        and exit non-zero. API failures carry the same shape in the envelope.
      </p>
      <table className="table docs-table">
        <thead><tr><th>Code</th><th>Meaning &amp; fix</th></tr></thead>
        <tbody>
          <tr><td className="mono">E_BAD_ARGS</td><td>Invalid arguments/flags (exit 2). Check the command's flags.</td></tr>
          <tr><td className="mono">E_NO_ROUTES</td><td>No routes in <code>app/routes</code>. Create <code>app/routes/index.tsx</code> (or run <code>podkit build</code> first for <code>start</code>).</td></tr>
          <tr><td className="mono">E_BAD_STATE</td><td>Refused due to state — e.g. <code>init</code> won't overwrite files, or an upload exceeded 500 MiB.</td></tr>
          <tr><td className="mono">E_UNAUTHORIZED</td><td>Token invalid/expired. Re-run <code>podkit cloud login</code>.</td></tr>
          <tr><td className="mono">E_NETWORK</td><td>Control-plane unreachable. Check <code>PODKIT_API_URL</code> / the server.</td></tr>
          <tr><td className="mono">E_QUOTA</td><td>Project limit reached (403). Delete a project or raise <code>PODKIT_MAX_PROJECTS_PER_ACCOUNT</code>.</td></tr>
          <tr><td className="mono">E_RATE_LIMITED</td><td>Too many requests (429). Back off; raise <code>PODKIT_RATE_LIMIT_PER_MIN</code> if self-hosting.</td></tr>
          <tr><td className="mono">E_NO_ROUTE / E_UPSTREAM</td><td>Gateway 502: no app routed for that host, or the app failed to respond.</td></tr>
          <tr><td className="mono">E_NOT_IMPLEMENTED</td><td>Feature not built yet (e.g. <code>db studio</code>).</td></tr>
        </tbody>
      </table>

      <h3>Common issues</h3>
      <table className="table docs-table">
        <thead><tr><th>Symptom</th><th>Likely cause</th></tr></thead>
        <tbody>
          <tr><td>Deploy succeeds but the URL 502s</td><td>App didn't bind the expected port. Pass <code>--containerPort</code> matching what your app listens on (default 3000).</td></tr>
          <tr><td><code>@podkit/*</code> won't resolve locally</td><td>App lives outside a podkit checkout. Create it under the workspace until packages are published.</td></tr>
          <tr><td>Loader <code>auth</code> is always null</td><td>No <code>Authorization: Bearer</code> header / <code>podkit_session</code> cookie, or a mismatched <code>PODKIT_AUTH_SECRET</code>.</td></tr>
          <tr><td>Deploy rejected at 400</td><td>Build-context validation tripped (a disallowed path, symlink, or traversal). Deploy from your app directory.</td></tr>
        </tbody>
      </table>
    </section>
  );
}
