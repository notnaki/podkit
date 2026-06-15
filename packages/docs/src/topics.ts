export interface Doc {
  topic: string;
  title: string;
  content: string;
}

const registry: Record<string, Doc> = {
  routing: {
    topic: "routing",
    title: "Routing",
    content: `# Routing

podkit uses **file-based routing**. Routes live under \`app/routes\` and the
file path maps directly to the URL path.

- **Static routes** — \`app/routes/about.tsx\` serves \`/about\`.
- **Dynamic segments** — a bracketed filename like \`[id].tsx\` (e.g.
  \`app/routes/posts/[id].tsx\`) matches a single path segment and exposes it as
  the \`id\` param.
- **Catch-all routes** — \`[...slug].tsx\` matches one or more trailing segments
  and exposes them as an array param \`slug\`.
- **Nesting** — directories create nested route segments; an \`index.tsx\` in a
  directory serves that directory's path.

Each route module is **server-rendered (SSR)** on every request. A route
exports a default component and an optional \`loader(ctx)\` function. The loader
runs on the server with a \`LoaderContext\` (\`params\`, the request \`url\`, and
the resolved \`auth\` identity or null); its return value is passed to the default
component as the \`data\` prop and rendered to HTML with React. Type the prop with
\`PageProps<LoaderData<typeof loader>>\` so the component and loader can't drift.

(There is no \`action\` export yet — loaders are read-side only. Handle writes
from your own server logic or a future actions API.)`,
  },
  db: {
    topic: "db",
    title: "Database",
    content: `# Database

podkit treats your **schema as code** via \`@podkit/db\`. You define tables in
TypeScript and podkit derives migrations from them.

- \`podkit db migrate\` — generates and applies pending migrations so the
  database matches the schema declared in code. Applied migrations are tracked
  and the command is idempotent.
- \`podkit db pull\` — introspects the live database and writes the current
  schema back to code, useful for adopting an existing database.

Tables are written with helpers re-exported from \`@podkit/db\` (e.g.
\`pgTable\`, \`text\`, \`integer\`, \`uuidPk\`). podkit also ships **row-level
security (RLS)** helpers — \`enableRls(table)\`, \`ownedBy(table, column)\`,
\`inOrg(table, column)\`, \`isAgent(table)\`, and \`customPolicy(...)\` — that emit
Postgres policy SQL keyed on \`current_setting('podkit.user_id')\`,
\`podkit.org_id\`, and \`podkit.is_agent\`. You opt a table in with \`enableRls\`
and attach policies; once the verified principal is bound to those settings, rows
a user or agent token may not see are filtered at the database layer.

In the cloud, each project additionally gets its **own database and a scoped,
non-superuser role** (see the \`cloud\` topic) — a hard isolation boundary
independent of, and underneath, any RLS you add.`,
  },
  auth: {
    topic: "auth",
    title: "Authentication",
    content: `# Authentication

podkit auth recognizes two kinds of principals: **users** (human accounts) and
**agent tokens** (machine credentials for programmatic/agent access).

- The \`podkit auth\` command manages credentials — creating users and issuing
  or revoking agent tokens.
- Sessions and agent tokens are signed/verified using the
  \`PODKIT_AUTH_SECRET\` environment variable. This secret must be set in every
  environment; rotating it invalidates existing tokens.

An agent token is a bearer credential sent on requests; podkit verifies the
token, resolves the principal, and feeds that identity into RLS so a token only
ever sees the data its policies allow.`,
  },
  deploy: {
    topic: "deploy",
    title: "Deploy",
    content: `# Deploy

podkit deploys **immutable versions**: each build produces a versioned,
content-addressed artifact that is never mutated after creation. Promotion and
rollback just point an environment at a different existing version.

- \`podkit deploy up\` — builds and uploads a new immutable version.
- \`podkit deploy promote\` — points an environment (e.g. production) at a given
  version, making it live.
- \`podkit deploy rollback\` — re-promotes a previously deployed version, an
  instant revert since the artifact still exists.
- \`podkit deploy claim\` — claims/binds a project or domain to the deploy
  target so subsequent deploys are authorized.

Because versions are immutable, a rollback is deterministic: you always get back
exactly the bits that were previously running.

This \`podkit deploy\` family is the **local** deploy registry (versions on disk).
To deploy to a hosted control-plane, see the \`cloud\` topic and
\`podkit cloud deploy\`.`,
  },
  cli: {
    topic: "cli",
    title: "CLI",
    content: `# CLI

The \`podkit\` CLI is built for both humans and agents.

- **\`--json\` envelope** — passing \`--json\` makes any command emit a single
  structured JSON envelope on stdout instead of human-formatted text, so output
  can be parsed reliably by tools and agents.
- **Structured errors** — failures are returned as structured objects carrying
  a machine-readable \`code\` and a human-actionable \`hint\` describing how to
  fix the problem, alongside the message. The process exit code is non-zero on
  failure.

This makes the CLI scriptable: read the \`--json\` envelope, branch on the error
\`code\`, and surface the \`hint\` to the operator.`,
  },
  cloud: {
    topic: "cloud",
    title: "Cloud platform",
    content: `# Cloud platform

The \`podkit cloud\` commands talk to a **control-plane**: a hosted service that
provisions databases, builds uploaded apps, runs them in containers, and routes
public traffic through a gateway. The active control-plane URL and token come
from \`podkit cloud login\` (a browser device-code flow); override the URL with
\`--url\` or the \`PODKIT_API_URL\` environment variable.

A typical first deploy:

\`\`\`sh
podkit cloud login            # device-code sign-in; stores ~/.podkit/auth.json
podkit cloud create myapp     # provision the project + an isolated Postgres DB
podkit cloud deploy myapp     # tar cwd, upload, build, health-check, go live
podkit cloud open myapp       # open the live URL
\`\`\`

**One-click deploy.** \`podkit cloud deploy <slug>\` needs no Dockerfile, port,
or path. The CLI tars the current directory (excluding \`node_modules\`, \`.git\`,
\`.podkit/dist\`) and streams it to the control-plane, which extracts it under
strict path-traversal protection and builds a standalone image on a vendored base
(an explicit \`Dockerfile\` in the context, if present, wins instead). The new
container is health-checked at the exact address the gateway will dial *before*
the route is switched, so a failed deploy never takes the old version down. The
upload is streamed (never buffered whole) and capped at 500 MiB.

**Manage a project.** \`status\`, \`url\`, \`open\`, \`deployments\`,
\`rollback <slug> <deploymentId>\`, \`logs\`, and \`metrics\` cover the lifecycle.
Configure it with \`env set/list/rm\` (see the \`env\` topic), \`domains add/list/rm\`
for custom domains, and \`branches\`/\`preview\` for isolated database branches and
preview deploys (see the \`branches\` topic).`,
  },
  branches: {
    topic: "branches",
    title: "Database branches & preview deploys",
    content: `# Database branches & preview deploys

A **branch** is an isolated copy of a project's database, created with
\`CREATE DATABASE ... WITH TEMPLATE\` so it starts as a point-in-time fork and
diverges independently. Each branch gets its own scoped, non-superuser role and
its own connection string (returned once, at create time).

\`\`\`sh
podkit cloud branches create myapp staging   # forks the DB; prints a conn string
podkit cloud branches list myapp
podkit cloud branches rm myapp staging       # drops the branch DB + role (confirms)
\`\`\`

A **preview deploy** runs a version of your app against a branch instead of
production:

\`\`\`sh
podkit cloud preview myapp staging           # deploy cwd against the 'staging' branch
podkit cloud preview list myapp
\`\`\`

Production serves at \`/_p/<slug>/\`; a preview gets its own route key of the form
\`<slug>--<branch>\` and is tracked separately, so a preview never owns the
production route and tearing one down never disturbs production. Preview deploys
automatically receive the branch's connection string as \`DATABASE_URL\`.`,
  },
  env: {
    topic: "env",
    title: "Environment variables & secrets",
    content: `# Environment variables & secrets

Set per-project environment variables from the CLI; they are injected into the
container on the next deploy.

\`\`\`sh
podkit cloud env set myapp FEATURE_X=on
podkit cloud env set myapp STRIPE_KEY=sk_live_... --sensitive
podkit cloud env list myapp
podkit cloud env rm myapp FEATURE_X
\`\`\`

Keys must match \`^[A-Za-z_][A-Za-z0-9_]*$\`. Values marked \`--sensitive\` are
**encrypted at rest** with AES-256-GCM (envelope format \`enc:v1:...\`) and are
never returned by \`env list\` (the value reads as null); non-sensitive values are
returned so you can confirm them.

A project's managed-Postgres connection string is provided to the app as
\`DATABASE_URL\` automatically — you don't set it yourself. On a preview deploy the
branch's connection string is substituted instead (see the \`branches\` topic).
Your own env vars are layered on top, so you can override values per deploy.`,
  },
};

export function listTopics(): string[] {
  return Object.keys(registry).sort();
}

export function getDoc(topic: string): Doc | null {
  return registry[topic] ?? null;
}
