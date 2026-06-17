# podkit

**An agents-first, humans-first-class application platform** — the framework, the
database, the auth, and the cloud that runs it, as one product. Think Vercel +
Supabase, with its own Next.js-class framework, built so that an AI agent and a
human are equally first-class operators of every surface.

> **Status: alpha.** The full local toolkit and the hosted cloud both work and are
> covered by 300+ tests against real Docker + Postgres. It self-hosts on a single
> Docker-capable VM today. It is **not yet hardened for untrusted multi-tenant
> use** — see [Caveats](#caveats). APIs may still change.

---

## Why podkit

Most stacks bolt a framework, a database, an auth provider, and a deploy target
together with glue you maintain. podkit is **one system** where those pillars
share a request lifecycle: a loader already knows who's calling (`ctx.auth`),
the database already enforces row-level rules from that identity, and every
request is already logged. And **every capability has two equal front doors** — a
typed CLI with a machine-readable `--json` envelope (for agents and scripts) and
a Vercel-style web console (for humans). Same control-plane API underneath.

```
┌────────────────────────────────────────────────────────────┐
│  podkit cloud (control-plane API)                            │
│  projects · deploys · managed Postgres · domains · metrics   │
└───────────────┬──────────────────────────┬──────────────────┘
        CLI  (agents)              Web console  (humans)
```

---

## Quickstart

**Requirements:** Node.js **22+** (podkit runs `.ts` directly via type-stripping —
no build step for the toolkit), [pnpm](https://pnpm.io), and Docker (only for the
hosted cloud).

```bash
git clone https://github.com/notnaki/podkit.git
cd podkit
pnpm install
pnpm test        # 300+ tests
pnpm typecheck
```

> Throughout, `podkit` means `node packages/cli/src/bin.ts`. Alias it if you like:
> `alias podkit="node $(pwd)/packages/cli/src/bin.ts"`.

### Run an app locally

```bash
# scaffold a new app:
node packages/cli/src/bin.ts init my-app

# …or run the bundled example (file-based routing + React SSR + hydration):
cd examples/hello
node ../../packages/cli/src/bin.ts dev
# open http://localhost:3000
```

Every command takes `--json` for a structured result envelope (`{ ok, data }` /
`{ ok, error: { code, message, hint } }`) — the agent-facing surface.

---

## Deploy to your own cloud

The hosted side is a control-plane that builds and runs each app in its own
Docker container, gives it a **managed Postgres database**, and routes a public
URL to it. Bring up the whole cloud locally with Docker Compose:

```bash
pnpm cloud:up        # boots Postgres + the control-plane (API :8080, gateway :8090)
# open http://localhost:8080  → the web console
```

Then deploy an app with **one command — no Dockerfile, no flags**:

```bash
node packages/cli/src/bin.ts cloud login                 # browser device-flow auth
node packages/cli/src/bin.ts cloud deploy my-app          # build → run → routed URL
node packages/cli/src/bin.ts cloud deployments my-app     # history; rollback is instant
```

What you get per project: an immutable, atomically-promoted deploy with instant
rollback, a managed Postgres DB (scoped non-superuser role), preview deploys per
DB branch (`cloud preview <app> <branch>`), env vars (encrypted at rest), custom
domains, runtime logs, request metrics, and **scale-to-zero** with a cold-start
holding page (opt-in via `PODKIT_IDLE_TIMEOUT_MIN`).

For a real deployment (a Docker VM + secrets + TLS via Caddy + DNS), see
**[docs/DEPLOY.md](docs/DEPLOY.md)** and `pnpm cloud:prod:up`.

---

## What's inside

| Pillar | Highlights |
|---|---|
| **Framework** (`@podkit/framework`) | File-based routing (static/dynamic/catch-all), nested `_layout`s, typed loaders/actions, React SSR with **client hydration** (server-only code stripped from the client bundle), **streaming SSR**, static prerender + ISR, `getStaticPaths`, and SPA navigation with `<Link>` prefetch + scroll restoration. |
| **Database** (`@podkit/db`) | Schema-as-code over drizzle, real Postgres (embedded [pglite](https://github.com/electric-sql/pglite) in dev — no external DB), versioned migrations, `db pull` (introspect a live DB → SQL + regenerated TS schema), a two-tier **RLS** policy DSL, **realtime** (LISTEN/NOTIFY), and **auto-generated REST** CRUD that runs through the caller's RLS. |
| **Auth** (`@podkit/auth`) | Two first-class identities — human users (scrypt) and agent tokens (HMAC, TTL + revocation) — RBAC, and session → Postgres GUCs so the `@podkit/db` row policies actually filter. |
| **Deploy + Cloud** (`@podkit/deploy`, `@podkit/cloud-host`, `@podkit/gateway`, `@podkit/runtime`, …) | Immutable versions, atomic promote, multi-step rollback, a **zero-config buildpack** (push an app, no Dockerfile), managed Postgres-per-project + branching, a reverse-proxy edge (path + custom-domain routing), and a multi-tenant control-plane with ownership enforcement, quotas, and container hardening (`cap-drop ALL`, `no-new-privileges`, non-root, loopback-bound). |
| **Telemetry** (`@podkit/telemetry`) | Structured event sink, logs (`--follow`), analytics (aggregate/funnel), traces/spans. |
| **Docs** (`@podkit/docs`) | Machine-readable platform docs + live project introspection, surfaced at `/docs` and via `podkit docs`. |

Two clients sit on top: **`apps/cloud-console`** (the public site + multi-tenant
console, served by the cloud at `:8080`) and **`apps/dashboard`** (per-project).

---

## Example app layout

```
examples/hello/app/
├── routes/
│   ├── _layout.tsx          # root layout (wraps every page)
│   ├── index.tsx            # /            — typed loader + SSR
│   ├── counter.tsx          # /counter     — client hydration (useState works)
│   ├── products/[id].tsx    # /products/:id — dynamic segment
│   ├── docs/[...path].tsx   # /docs/*       — catch-all
│   ├── static-page.tsx      # prerendered at build
│   ├── isr-page.tsx         # stale-while-revalidate
│   └── blog/_layout.tsx     # nested layout + its own loader
└── db/
    ├── schema.ts            # schema-as-code
    └── migrations/          # versioned SQL
```

```ts
// app/routes/index.tsx — loader runs on the server; data is typed into the page
import type { LoaderData, PageProps } from "@podkit/framework";

export async function loader() {
  return { now: new Date().toISOString() };
}

export default function Home({ data }: PageProps<LoaderData<typeof loader>>) {
  return <h1>Hello from podkit — {data.now}</h1>;
}
```

---

## Documentation

- **In-product `/docs`** (run `pnpm cloud:up`, open `http://localhost:8080/docs`) —
  getting started, an end-to-end tutorial, framework, database, full CLI + REST
  API references, configuration, self-hosting, and troubleshooting.
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — self-hosting runbook (Docker VM → secrets → TLS → DNS).
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what's shipped and what's next.

---

## Caveats

Read these before relying on podkit for anything serious:

- **Untrusted multi-tenant is not yet safe.** The control-plane mounts the host
  Docker socket, and secrets are injected as plaintext `-e` into containers — a
  tenant breakout is host root. Fine for your own apps / a trusted team on a VM;
  **not** for running arbitrary third-party code. (Both are tracked architectural
  items in the roadmap.)
- **TLS / custom domains** need a reverse proxy (Caddy) in front today; in-podkit
  ACME and DNS-ownership verification are not done yet.
- **RLS in dev** doesn't filter — pglite connects as superuser (which bypasses
  RLS). Policies are proven under a non-privileged role in tests and bite in
  production with the scoped app role.
- **Erasable-only TypeScript** — no `enum`/`namespace`/parameter-properties;
  imports use explicit `.ts`/`.tsx` extensions (ESM). Enforced by
  `erasableSyntaxOnly` so Node can type-strip and run sources directly.

---

## License

[MIT](LICENSE) © Nuh Naci Kusculu
