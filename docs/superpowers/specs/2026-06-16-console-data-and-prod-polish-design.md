# Console data editor + clean URLs + prod-optimized builds

Date: 2026-06-16
Status: approved (user: "all of them sequentially do them autonomously")
Branch: `feat/console-data-and-prod-polish` (stacked on `feat/server-actions-and-managed-db`)

Three independent units, built and verified in order. Each is its own commit;
the cloud is re-deployed and checked live after the relevant unit.

## Unit A — Database table editor (console)

Today the console Database tab only has a read-only SQL runner. Add a Supabase-
style **table editor**: browse tables, view/paginate rows, and **insert / edit /
delete** rows from the UI — no SQL.

### Data access — `packages/cloud-host/src/db-tables.ts` (new, pure functions)

Operate over a connected `pg` Client (so they unit-test against a real Postgres
container like the other db tests). Identifier safety is the core concern:

- `listTables(client)` → `[{ name, columns: [{ name, dataType, nullable, isPk }] }]`
  from `information_schema` + primary-key columns from `pg_index`/`pg_attribute`.
- `getRows(client, table, { limit, offset })` → `{ rows, total }` (SELECT with
  `LIMIT`/`OFFSET` + a `COUNT(*)`), ordered by the pk (or first column).
- `insertRow(client, table, values)` → the inserted row (`RETURNING *`).
- `updateRow(client, table, pk, values)` → the updated row.
- `deleteRow(client, table, pk)` → void.

**Injection defense:** identifiers (table, column names) can't be parameterized,
so every identifier is validated against the table's live schema (a whitelist
fetched from `information_schema`) and quoted with `"…"`; a name containing `"`
is rejected. All values flow through `$1..$N` parameter slots only. Update/delete
require the table to have a primary key (else `E_NO_PK`); the pk identifies the
row.

### Endpoints — `host.ts` (ownership-gated, scoped non-superuser role)

Same guard ladder as `db/query` (`guardMutation` → `getProjectBySlug` 404 →
`authorizeProject` 401/403), and the same scoped-connection resolution (the
stored per-project `db_url`, or a branch's via `?branchName`) — never admin. A
shared `resolveScopedConn(project, branchName)` helper factors that out (reused
by `db/query`).

- `GET    /v1/projects/:slug/db/tables` → tables + columns
- `GET    /v1/projects/:slug/db/tables/:table?limit&offset` → `{ columns, rows, total }`
- `POST   /v1/projects/:slug/db/tables/:table` `{ values }` → inserted row
- `PATCH  /v1/projects/:slug/db/tables/:table` `{ pk, values }` → updated row
- `DELETE /v1/projects/:slug/db/tables/:table` `{ pk }` → ok

Writes go through `guardMutation`; reads through the same auth (DB contents are
sensitive, like logs). Errors are generic (`E_QUERY_FAILED`) — no driver leakage.

### Console — `apps/cloud-console/src/pages/Project.tsx` + `api.ts`

Database tab gains a tables list; selecting a table loads a paginated row grid
with **Add row** (a field per column), per-row **Edit** (modal/inline) and
**Delete** (confirm). The existing SQL console stays as an "Advanced" affordance.
api client gets `getTables/getTableRows/insertRow/updateRow/deleteRow`.

### Tests
- `db-tables.test.ts` (real PG container): list/get/insert/update/delete round-trip;
  identifier validation rejects unknown/quoted names and an injection attempt;
  no-pk table rejects update/delete.
- `host.ts` endpoint test: ownership-gated CRUD round-trip on a provisioned project.

## Unit B — Clean URLs (auto-subdomain), hide the plumbing

Apps are surfaced as `/_p/<slug>/`, which leaks the platform's routing and breaks
apps that use absolute paths (a redirect to `/` escapes the prefix). Give every
project a **default host at the root**, Vercel-style, with no manual domain step.

- New `PODKIT_APPS_DOMAIN` (default `localhost`; prod sets e.g. `apps.podkit.dev`
  with wildcard DNS). Threaded through `createCloud` → the gateway resolver and
  the URL builder.
- **Gateway resolve order:** `/_p/<slug>` path → exact custom-domain match →
  **wildcard**: if the Host (minus port) is `<label>.<appsDomain>`, the `<label>`
  is the route key (`<slug>` for prod, `<slug>--<branch>` for previews) → look it
  up in `routeMap`. No per-project registration — one rule covers all projects.
- The project/preview **`url` becomes the clean root URL**
  (`http://<slug>.<appsDomain>:<port>/`); `/_p/<slug>/` stays as a fallback so
  nothing breaks. CLI `url`/`open` and the console surface the clean URL.
- Because the app is now served at a host root, absolute-path redirects (login →
  `/`) work without any base-path awareness — the `/_p` rough edge is gone for
  the default URL.

### Tests
- Gateway resolve unit tests: `notes.localhost` → `notes`; `notes--staging.localhost`
  → `notes--staging`; unrelated host → null; `/_p/<slug>` still works.
- cloud-host: a deployed project's returned `url` is the subdomain form and the
  gateway serves the app via the Host header.

## Unit C — Prod-optimized deploy image

A deployed image is ~1.8 GB (the runtime stage copies the whole workspace incl.
dev dependencies) and `NODE_ENV` is unset (so React runs its dev build and the
framework's prod cookie defaults don't engage).

- Runtime stage of both generated Dockerfiles: `ENV NODE_ENV=production`, and
  `pnpm prune --prod` at the workspace root to drop devDependencies (typescript,
  vitest, drizzle-kit, @types/*, etc.) from the shipped image.
- Verify the app still builds + runs after the prune (the Vite-free prod server
  and its runtime deps remain) and measure the image-size reduction.
- Further slimming (moving `vite` to a dev-only dep of `@podkit/framework` so prod
  images don't ship the bundler) is noted as a follow-up — it's a framework
  packaging change beyond this pass.

### Tests
- `buildpack-run.test` (builds + runs a podkit app) stays green.
- Live: re-deploy `notes`, confirm it serves and `printenv NODE_ENV` = production
  in the container; record image size before/after.

## Acceptance
- `pnpm test` + `pnpm typecheck` green (and `pnpm --filter @podkit/cloud-console
  typecheck` for console changes).
- Live on the running cloud: browse + edit a table in the console; the `notes`
  app reachable at its clean subdomain URL; deployed image smaller with
  `NODE_ENV=production`.
