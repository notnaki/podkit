# podkit — Roadmap & Status

**What podkit is:** an agents-first, humans-first-class application platform (Vercel + Supabase class) with its own Next.js-class framework. Design: [platform spec](superpowers/specs/2026-06-13-podkit-platform-design.md).

This file tracks **what we've done** and **what's left**. Keep it current as phases land.

---

## ✅ Done — the local toolkit (all merged to `main`)

Seven packages, ~127 tests, clean typecheck. Everything runs **locally** (embedded Postgres via pglite, local filesystem). This is the SDK/runtime an app is written against — *not* the hosted service.

| Package | What it does | CLI |
|---|---|---|
| `@podkit/framework` | file-based routing (static/dynamic/catch-all), React SSR, typed loaders | `podkit dev` |
| `@podkit/cli` | agents-first surface: `--json` envelope, structured errors (code + hint) | — |
| `@podkit/db` | schema-as-code (drizzle), real Postgres (pglite), migrations, two-tier RLS DSL | `podkit db migrate\|pull\|studio` |
| `@podkit/auth` | users + agent tokens, scrypt, RBAC, `createAuth`, session→GUC (RLS) | `podkit auth token\|whoami\|signup\|login` |
| `@podkit/deploy` | deploy *mechanics*: immutable versions, atomic promote, multi-step rollback, anonymous→claim | `podkit deploy up\|promote\|rollback\|deployments\|claim` |
| `@podkit/telemetry` | event sink, structured logs, analytics (aggregate/funnel) | `podkit logs`, `podkit analytics query` |
| `@podkit/docs` | machine-readable platform docs + auto project introspection | `podkit docs <topic>\|project` |

---

## ✅ Done — request lifecycle + the cloud's two clients

- **0.7 — Request lifecycle** (PR #7): the dev-server threads the **auth identity into every loader** (`ctx.auth`) and **auto-logs every request to telemetry**. The "one product" thesis at the request level.
- **0.8 — Control-plane API** (PR #8): `@podkit/cloud` — the spec's "one control-plane API" over the pillars, `Envelope` JSON, API-key guarded (fail-closed), CORS for browser clients. Local/single-project slice.
- **0.9 — Dashboard** (PR #9): `apps/dashboard` — the human-first-class console over the control-plane API (overview/deployments/database/auth/logs/analytics/docs). The CLI's counterpart client.

---

## ✅ Done — the real cloud platform (Docker hosting, PRs #11–#17)

The hosted multi-tenant cloud, built on real Docker and tested on a real machine. **213 tests on `main`, 13 packages + 2 apps.**
- **`@podkit/runtime`** — builds + runs app **Docker containers**; **zero-config buildpack** (`isPodkitApp`/`generatePodkitDockerfile`/`buildPodkitApp` — push a podkit app, no Dockerfile, it runs) (PR #14)
- **`@podkit/cloud-store`** — control-plane persistence in **real Postgres** (raw parameterized SQL): projects, deployments, accounts, cli_auth_sessions, project_env, project_domains
- **`@podkit/gateway`** — reverse-proxy edge: `/_p/<project>` path routing **and Host-header → custom-domain routing** (PR #17)
- **`@podkit/db-provision`** — **managed Postgres-per-project** (Supabase part)
- **`@podkit/cloud-host`** — `createCloud`: create project → provision DB → build+run container → routed public URL; **account auth + CLI device flow**, **env injection at deploy**, **custom domains**; serves the cloud-console as a same-origin SPA. API-key + user-Bearer guarded; full loop proven against real Docker+Postgres.
- **`infra/docker-compose.yml`** — boots Postgres + control-plane (`pnpm cloud:up`); compose-tested. Control-plane image builds the console and sets `PODKIT_CONSOLE_DIR`.
- **Consoles** — `apps/cloud-console` (multi-tenant, Vercel-style, **served from the cloud on :8080**, PR #15) + `apps/dashboard` (per-project). `podkit cloud` CLI: `projects|create|deploy|url|login|logout|whoami|env|domains`.

### Cloud feature waves landed
- **Cloud auth + zero-config deploy** (PR #14): accounts (email/scrypt), `podkit cloud login` browser **device flow** (→ `~/.podkit/auth.json` 0600 → Bearer), console **login gate** + `/#/cli` authorize; security-hardened (cli-session 10m expiry + single-use approve, anti-phishing, appSubpath validated, 8-char password floor). Zero-config buildpack wired into deploy.
- **Console served from the cloud** (PR #15): control-plane serves the built cloud-console as a same-origin SPA on :8080 (API under /v1, gateway :8090). Vite dev proxy keeps standalone dev (:5190) working.
- **Env vars** (PR #16): project_env (sensitive/plain), `POST/GET/DELETE /v1/projects/:slug/env` (masked on read), injected into the container at deploy, console Environment tab + `podkit cloud env set|list|rm`.
- **Custom domains** (PR #17): project_domains, gateway resolves by Host header (domain→slug→container), console Domains tab + `podkit cloud domains add|list|rm`.
- **Deployment history + rollback** (PR #18): deployments persist `container_port`+`kind`; `GET /v1/projects/:slug/deployments` (newest-first, active flag) + `POST /v1/projects/:slug/rollback {deploymentId}` re-runs a prior version's immutable image as a new deployment and reroutes instantly. Console Deployments tab is a full history table with per-row Rollback/Current; `podkit cloud deployments|rollback`.
- **Runtime logs** (PR #19): `GET /v1/projects/:slug/logs[?deploymentId=]` returns a deployment's container logs (`docker logs` of the active deployment by default). **Auth-required** (logs can contain secrets) — unlike the other open read endpoints. Console **Logs** tab (terminal-style, refresh) + `podkit cloud logs <slug>`.
- **Per-project scoped DB roles** (PR #20): `provisionDatabase` now mints a **non-superuser per-project login role** (`<db>_app`) that owns only its own database + `public` schema; PUBLIC `CONNECT` is revoked so a tenant's creds can't reach any other tenant's DB. The returned connectionString carries the scoped role creds (no more admin/superuser handed to tenants); re-provision rotates the password; `dropDatabase` can drop the role too. **Note:** projects provisioned before this still have admin creds in any DATABASE_URL they stored — re-provision/rotate to fix.
- **Security hardening** (PR #22, multi-agent audit→fix workflow): (1) **multi-tenant ownership enforcement** — every project-scoped endpoint now requires the bearer account to OWN the project (machine key = full access), 403 `E_FORBIDDEN` otherwise; `GET /v1/projects` filters to the caller; **create binds owner to the authenticated account** (not the request body — closes a lockout + spoof hole). (2) error-message masking (no stack/cred leakage in 500s). (3) container resource limits (`--memory/--cpus/--pids-limit/--ulimit`). (4) request body-size cap (1 MiB → 413).
- **CLI/console/lifecycle improvements** (PR #21, worktree-isolated workflow): CLI semantic exit codes + `--quiet`; `podkit cloud status <slug>`; **`DELETE /v1/projects/:slug`** full teardown (stop container, drop DB+role, cascade env/domains/deployments) + working console **Delete** button; "deployed N ago" age on project cards.
- **Hardening batch 2** (PR #23): (1) **secrets-at-rest** — `project_env` values AES-256-GCM encrypted (`PODKIT_SECRETS_KEY`, prod-required; legacy plaintext passthrough, no migration). (2) **token expiry** — `signToken(…, ttlSeconds?)` stamps `iat`/`exp`, `verifyToken` rejects expired (backward-tolerant). (3) **CORS allowlist** — `PODKIT_CORS_ORIGINS` (unset = prior `*`). (4) **deploy build-context sandboxing** — `validateContextDir` rejects `..`/system dirs/control-plane overlap; `PODKIT_BUILDS_ROOT` confines builds.
- **Hardening batch 3** (PR #24): (1) **token TTL wiring + revocation** — issue sites now stamp TTLs (account 30d, CLI 90d) + a `jti`; `revoked_tokens` table + `POST /v1/auth/logout` revokes by `jti`; `accountFromAuth` rejects revoked tokens (jti-less = backward-compatible). (2) **container hardening** — tenant containers run `--cap-drop ALL`, `--security-opt no-new-privileges`, ports bound to `127.0.0.1` only. (3) **e2e test-image cleanup** — best-effort `afterAll docker rmi` per suite so built images stop accumulating.
- **Hardening batch 4** (PR #25): (1) **device-flow** — `userCode` entropy 32→128 bits; in-memory rate-limit on `/v1/auth/cli/approve` (10/60s per account → 429). (2) **non-root tenant images** — buildpack-generated Dockerfile drops to `USER node` (control-plane left root: needs docker-socket access).
- **Product wave 2** (PR #26, secure-by-default): (1) **request metrics** — gateway records per-project `{requests, status buckets, avgLatency, lastSeen}`; ownership-gated `GET /v1/projects/:slug/metrics`. (2) **log `?limit`/`?since`**. (3) **CLI** `podkit cloud open <slug>` + `--table` output. (4) **read-only SQL runner** `POST /v1/projects/:slug/db/query` — ownership-gated, SELECT-only, statement-timeout + LIMIT, parameterized, runs as the **scoped non-superuser role**; scoped DB connection string now **stored encrypted at rest** (reused, no per-query rotation).
- **Console UI** (PR #27): surfaces #26 in the cloud-console — **Metrics tab**, **Database tab** (read-only SQL console), **log filters** (lines/since), and copy-to-clipboard for URLs + connection string.

## 📋 To do — cloud hardening (toward production)

1. **Secret-injection redesign** — env is encrypted at rest (#23) but still injected as plaintext `-e` into containers, and the per-project connection string is returned in the create response; move to a credential-broker / Docker secrets flow. *(Architectural — needs sign-off.)*
2. **docker.sock host-escape** — the control-plane mounts the host Docker socket; move to a brokered build/run service or orchestrator. *(Architectural — needs sign-off.)* Smaller remaining container hardening: `--read-only` rootfs (+ writable tmpfs), pinned base-image digests, non-root control-plane (needs docker-group gid mapping).
4. **Domain ownership verification + TLS** — DNS TXT challenge + ACME cert issuance for custom domains.
5. **Standalone buildpack** — support apps outside the monorepo (published packages).
6. **Prod app bundling** — containers run the dev server; add an optimized production build/runtime, cold-start, edge.
7. **Stop superseded containers on deploy/rollback** — prior container lingers until shutdown; reap to reclaim resources.
8. **DB branching, telemetry-at-scale, self-host packaging (IaC).**

---

## 📋 To do — deferred platform features (buildable locally)

- **Auth:** OAuth (Google/GitHub), passkeys, magic links, SSO/SAML; **session token expiry + table-backed revocation** (`sessions.expiresAt` exists, unused).
- **DB:** branching (preview-deploy isolated branches), realtime subscriptions, auto-generated REST, `db pull` regenerating the TS schema.
- **Framework:** nested `_layout`, streaming SSR, static/ISR modes; production bundling; route-aware client navigation (current client entry is a minimal hydration shell).
- **Telemetry:** traces/spans, log `--tail` follow, alerting.
- **Docs:** rendered human docs site, `llms.txt` manifest, version-pinned docs.

---

## ⚠️ Known constraints & caveats (read before building)

- **Erasable-only TypeScript** — no enums/namespaces/parameter properties; podkit runs `.ts` directly via Node type-stripping (enforced by `erasableSyntaxOnly`). Imports use explicit `.ts`/`.tsx` extensions (ESM).
- **RLS in dev** — pglite connects as a Postgres **superuser**, which *bypasses* RLS. Policies + `applySessionGuc` are proven (under a non-superuser role in tests), but row-filtering only bites in production with a non-privileged app role. The dev-server sets the GUCs; full filtering is a prod concern.
- **`PODKIT_AUTH_SECRET`** — required in production (token signing); dev uses an insecure default with a warning.
- **Workflow scripts** can't reference `Date.now()`/`Math.random()` (even in strings — the validator scans source).

---

## Architecture in one line

One **control-plane API** over the pillar packages; the **CLI** (agent's surface) and the **dashboard** (human's surface) are both clients of it. Build deeply: framework, CLI/control-plane, docs, integration. Compose engines: Postgres, auth primitives, the (future) hosting runtime.
