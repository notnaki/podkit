# notes — example app

A small **multi-account** app built with [podkit](https://github.com/notnaki/podkit):
sign up, sign in, and keep your own private notes. Each account only ever sees
its own data. A more complete example than `hello` — it exercises auth, a
database, and server actions together.

What it shows off:

- **Server actions** — `app/routes/index.tsx` exports `action()`; signup/login set
  an httpOnly session cookie, create/delete write to the DB, all via POST forms
  (no client JS needed — it's fully server-rendered).
- **Auth** — `@podkit/auth` (`createAuth`) for password hashing + signed sessions;
  the framework verifies the session cookie and hands the route a typed `ctx.auth`.
- **Managed Postgres** — `@podkit/db`'s `createDbClient` uses the injected
  `DATABASE_URL` in the cloud (embedded pglite locally). Schema is created on boot.
- **Per-user isolation** — every query is scoped by the authenticated `userId`.

## Run locally

From the repo root, after `pnpm install`:

```sh
pnpm --filter notes dev          # http://localhost:3000
# …or:  cd examples/notes && node ../../packages/cli/src/bin.ts dev
```

## Deploy

```sh
podkit cloud login
podkit cloud deploy notes        # no Dockerfile, no flags
```

The cloud builds the app on the vendored base image, provisions a Postgres,
injects `DATABASE_URL`, and serves it at a routed URL.
