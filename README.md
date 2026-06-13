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

Deferred to later phases: RLS injection into loaders with the auth session
(Phase 0.3), `db pull` regenerating the TS schema, DB branching, realtime.
