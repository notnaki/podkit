# podkit

Agents-first, humans-first-class application platform. See the design at
`docs/superpowers/specs/2026-06-13-podkit-platform-design.md`.

## Phase 0.1 — framework foundation

```bash
pnpm install
pnpm test
pnpm typecheck

# run the example app (file-based routing + SSR React):
cd examples/hello && node ../../packages/cli/src/bin.ts dev
# open http://localhost:3000
```

What works today: file-based routing (`app/routes`, static/dynamic/catch-all),
React SSR with typed loaders and hydration data, and a `podkit dev` CLI command
with the agents-first `--json` result envelope and structured errors.

## Phase 0.2 — DB layer (`@podkit/db`)

Real Postgres (in-process via [pglite](https://github.com/electric-sql/pglite) — no external DB),
schema-as-code in TypeScript (drizzle), versioned migration files, and two-tier RLS.

```bash
# define your schema in app/db/schema.ts, then:
cd examples/hello
node ../../packages/cli/src/bin.ts db migrate --json   # generate + apply migrations
node ../../packages/cli/src/bin.ts db pull --json       # capture out-of-band DDL into a migration
```

Schema example (`examples/hello/app/db/schema.ts`):

```ts
import { pgTable, uuidPk, text, timestamp } from "@podkit/db";

export const posts = pgTable("posts", {
  id: uuidPk(),
  title: text("title"),
  body: text("body"),
  createdAt: timestamp("created_at"),
});
```

What works today: schema-as-code over drizzle pg-core (`@podkit/db`), `db migrate`
(generate via drizzle-kit + idempotent apply tracked in `_podkit_migrations`),
`db pull` (introspect live DB → migration file), and a two-tier RLS policy DSL
(`ownedBy` / `inOrg` / `isAgent` + `customPolicy`). `db studio` is a stub.

Deferred to later phases: `db pull` regenerating the TS schema, DB branching, realtime.

## Phase 0.3 — Auth (`@podkit/auth`)

Two first-class identities (human users + agent tokens) on owned primitives —
scrypt password hashing, HMAC signed tokens, an org/RBAC model — plus the wiring
that **completes the RLS story**: an authenticated session sets Postgres GUCs
(`podkit.user_id` / `podkit.org_id` / `podkit.is_agent`) so the row-level
policies from `@podkit/db` actually filter rows.

```bash
export PODKIT_AUTH_SECRET="$(openssl rand -hex 32)"   # required in production

# agents-first surface — issue and verify scoped agent tokens (no DB needed):
node packages/cli/src/bin.ts auth token --user <id> --scope read --json
node packages/cli/src/bin.ts auth whoami --token <token> --json

# human users (DB-backed):
node packages/cli/src/bin.ts auth signup --email a@b.com --password ... --json
node packages/cli/src/bin.ts auth login  --email a@b.com --password ... --json
```

What works today: `createAuth({db,secret})` (signup/login/verifySession/agent
tokens), `applySessionGuc` (session → RLS, proven end-to-end), RBAC helpers, and
`podkit auth token|whoami|signup|login`. Without `PODKIT_AUTH_SECRET`, dev uses an
insecure default (with a warning) and **production refuses to run**.

Deferred: OAuth/passkeys/SSO, session-table revocation + token expiry, automatic
per-request session→GUC injection in the dev-server loader, org-switching UX.
