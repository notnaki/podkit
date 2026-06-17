# Server actions + managed-Postgres client (and a multi-account notes app)

Date: 2026-06-15
Status: approved (user: "do whatever is necessary")

## Problem

A real multi-account app — sign up, log in, create/read/delete your own private
data — needs two things podkit does not yet have:

1. **Server-side mutations.** Route modules only export a GET `loader`.
   `LoaderContext` is `{ params, url, auth }`: no request body, no HTTP method,
   no way to set a cookie or redirect. Both the dev server and the prod server
   only ever match → run `loader` → render HTML; a POST is rendered like a GET.
   So an app can *read* per-user data but cannot *write* it, and cannot
   establish a browser session.

2. **A usable managed database.** The cloud provisions a Postgres per project and
   injects `DATABASE_URL` (a scoped, non-superuser role) into the container, but
   `@podkit/db`'s `createDbClient` is **pglite-only** — nothing reads
   `DATABASE_URL`. A deployed app therefore can't persist to its managed
   Postgres; it would run an ephemeral in-container pglite that resets on every
   redeploy.

Neither is on `docs/ROADMAP.md`. Together they are what make podkit apps
genuinely writable and persistent — a prerequisite for almost any real app, not
just this demo.

## Goals

- Add a minimal, well-tested **`action`** mutation primitive to `@podkit/framework`.
- Make `@podkit/db`'s `createDbClient` use **`DATABASE_URL` (node-postgres)** when
  set, falling back to pglite for local dev — same `DbClient` interface.
- Build a **multi-account notes app** (`~/Desktop/notes`) on top, and **deploy it
  live** to the local cloud so the build/deploy process is visible.

## Non-goals

- A general request/response abstraction (Web `Request`/`Response`). Keep the
  contract tiny and form-oriented.
- `multipart/form-data` / file uploads. v1 parses
  `application/x-www-form-urlencoded` only.
- Relying on RLS for per-user isolation in dev (pglite connects as superuser and
  bypasses RLS). The app scopes every query explicitly by `auth.userId`; RLS
  policies are optional defense-in-depth.

## Unit 1 — `action` mutation primitive (`@podkit/framework`)

### Route contract

A route module may export, in addition to `loader` and `default`:

```ts
export async function action(ctx: ActionContext): Promise<ActionResult>;
```

```ts
export interface ActionContext {
  params: Record<string, string>;
  url: URL;
  auth?: { userId: string; isAgent: boolean } | null; // resolved as for loaders
  method: string;                                      // "POST", "DELETE", ...
  formData: Record<string, string>;                    // parsed urlencoded body
}

export interface CookieDirective {
  name: string;
  value: string;            // "" + maxAge:0 clears the cookie
  maxAge?: number;          // seconds
  path?: string;            // default "/"
  httpOnly?: boolean;       // default true
  sameSite?: "Lax" | "Strict" | "None"; // default "Lax"
  secure?: boolean;         // default: true when NODE_ENV=production
}

export interface ActionResult {
  redirect: string;             // Location for the 303 response
  cookies?: CookieDirective[];  // applied as Set-Cookie before redirecting
}
```

### Server behavior (shared by dev + prod servers)

For a matched route, after `auth` is resolved exactly as today:

- **GET/HEAD** → unchanged (run `loader`, render HTML).
- **Other methods** with an exported `action`:
  1. Read the request body with a **1 MiB cap** → exceed ⇒ `413`.
  2. Parse `application/x-www-form-urlencoded` into `formData`.
  3. Call `action({ params, url, auth, method, formData })`.
  4. Serialize each `CookieDirective` to a `Set-Cookie` header, then respond
     **303** with `Location: result.redirect` (Post/Redirect/Get).
  5. If `action` throws ⇒ `500` (same masking as loader errors). Apps surface
     *expected* failures (bad login) by returning `{ redirect: "/?error=…" }`
     and reading `url.searchParams` in the loader.
- **Other methods** with no `action` ⇒ `405`.

Request logging is unchanged: it records method + path + status, **never the
body**, so passwords posted in a form stay out of `events.jsonl`.

### Shared implementation

Extract the per-request pipeline so dev and prod stay identical:

- `request/body.ts` — `readBody(req, limit)` (stream read + cap → throws a
  413-marker error) and `parseFormUrlEncoded(buf)` → `Record<string,string>`.
- `request/cookie.ts` — `serializeCookie(directive)` with the documented defaults.
- `runAction(mod, ctx)` in `loader/run.ts` (next to `runLoader`); `RouteModule`
  gains an optional `action`.
- A small helper applies the result to a `ServerResponse` (set cookies + 303),
  used by both servers.

### Tests (TDD, both servers)

- non-GET to a route with `action` → 303 + correct `Location`.
- `action` cookies → exact `Set-Cookie` (httpOnly, path, sameSite, maxAge=0 clears).
- `formData` parsed from a urlencoded body (incl. `+`/`%` decoding).
- non-GET to a route without `action` → 405.
- body over 1 MiB → 413.
- `action` throw → 500, no stack leak in prod-shaped path.
- GET still runs the loader (no regression).

## Unit 2 — managed-Postgres client (`@podkit/db`)

`createDbClient(opts?)` chooses a driver:

- **`DATABASE_URL` set** (or `opts.connectionString`) → connect with
  `drizzle-orm/node-postgres` over a `pg.Pool`. `raw(sql, params)` runs through
  the pool; `close()` ends it.
- **otherwise** → today's pglite path (`opts.dataDir`), unchanged.

The returned shape (`{ db, raw, close }`) and `applyMigrations` are unchanged, so
loaders, actions, and `podkit db migrate` work against either driver. This is the
single switch that makes deployed apps persist in managed Postgres.

### Tests

- With a real Postgres `DATABASE_URL` (the repo already runs Postgres for cloud
  tests): `createDbClient` connects, `raw` round-trips, `applyMigrations`
  creates tables, a second client sees them.
- No `DATABASE_URL` → pglite path still works (existing tests stay green).
- Driver selection precedence: explicit `connectionString` > `DATABASE_URL` >
  pglite.

## Unit 3 — the notes app (`~/Desktop/notes`, standalone) + live deploy

### Shape

- `app/db/schema.ts`: re-export `users` from `@podkit/auth` + a `notes` table
  (`id` uuid pk, `userId` uuid, `body` text, `createdAt` timestamptz).
- A tiny `app/lib/db.ts` and `app/lib/auth.ts` create the `DbClient` /
  `createAuth` once per process (DATABASE_URL in cloud, pglite `.podkit/pgdata`
  locally) and apply migrations on first use.
- Routes (file-based):
  - `/` — **logged out**: login + signup forms (POST `/login`, `/signup`),
    showing `?error` messages. **Logged in**: the user's notes
    (`SELECT … WHERE user_id = $auth.userId ORDER BY created_at DESC`), a
    new-note form (POST `/`), a delete button per note (POST `/notes/[id]/delete`),
    and a logout form (POST `/logout`).
  - `/login`, `/signup`, `/logout`, `/notes/[id]/delete` — `action`-only routes
    (their `loader`/component just redirect to `/`).
- Actions:
  - **signup** → `createAuth.signup` then `login` → set `podkit_session` cookie
    (httpOnly, signed via `signToken`) → 303 `/`.
  - **login** → `createAuth.login` → set cookie → `/`; invalid → `/?error=…`.
  - **logout** → clear cookie → `/`.
  - **create note** → insert `{ userId: auth.userId, body }` → `/`.
  - **delete note** → `DELETE … WHERE id = $1 AND user_id = $auth.userId` → `/`.
- **Isolation**: every query is scoped by `auth.userId`; unauthenticated POSTs
  redirect to `/`.
- Styling: minimal, monochrome, system font, centered card — "nice" but small.

### Local dev

`@podkit/*` aren't published, so `pnpm install` can't resolve them outside the
repo. Verify the app **inside the repo** first (a throwaway copy under
`examples/`), then place the real copy at `~/Desktop/notes` and symlink
`@podkit/*` + `react`/`react-dom` into its `node_modules` so `podkit dev` runs
there too. Deploy does not depend on this (the tarball builds on the base image;
`node_modules` is excluded from the upload).

### Deploy (the visible process)

1. `pnpm cloud:up` — control-plane :8080, gateway :8090, Postgres (Docker). This
   rebuilds `podkit-base` from the repo, so the image includes Units 1 & 2.
2. `podkit cloud login` (device flow) → `podkit cloud create notes`.
3. `podkit cloud deploy notes` — tars `~/Desktop/notes`, uploads, builds on the
   base image, provisions Postgres, injects `DATABASE_URL`, runs the container,
   routes a public URL.
4. Verify live via the preview MCP: sign up account A, create notes; sign up
   account B in a separate session, confirm B sees none of A's notes; screenshot.

## Testing & acceptance

- TDD for Units 1 & 2; an integration test for the app's signup → create →
  per-user list.
- `pnpm test` + `pnpm typecheck` green before merge (and the app's own typecheck).
- Live: two accounts, isolated notes, served from the deployed URL.

## Rollout

Units 1 & 2 land on `feat/server-actions-and-managed-db` (one coherent
"writable, persistent apps" capability; could be split into two PRs). The notes
app lives standalone at `~/Desktop/notes`. PRs/push are left for the user to
trigger (outward-facing); local commits only.
