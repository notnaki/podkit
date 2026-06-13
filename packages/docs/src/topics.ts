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
exports a default component plus optional \`loader\`/\`action\` functions; the
loader runs on the server, its data is passed to the component, and the
resulting HTML is streamed to the client.`,
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
\`pgTable\`, \`text\`, \`integer\`, \`uuidPk\`). podkit enforces **row-level
security (RLS)**: policies scope each query to the authenticated principal, so
rows a user or agent token is not permitted to see are filtered at the database
layer.`,
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
exactly the bits that were previously running.`,
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
};

export function listTopics(): string[] {
  return Object.keys(registry).sort();
}

export function getDoc(topic: string): Doc | null {
  return registry[topic] ?? null;
}
