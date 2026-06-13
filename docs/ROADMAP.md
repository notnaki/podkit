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

## 📋 To do — the cloud platform (the hosted "service")

The two clients exist; the hosted backend is the remaining build:

1. **Control-plane** — *exists (0.8)*. Next: project/tenant model, persistence, CLI pointing at a remote `PODKIT_API_URL`, dashboard auth, more read endpoints (schema/migrations, users/orgs).
2. **Hosting runtime** — actually *runs* deployed apps for real traffic (microVM/Firecracker or containers), prod SSR bundling, cold-start, edge. **Real infra — needs a provider; not sandbox-buildable.**
3. **Managed multi-tenant backend** — hosted Postgres per project (+ branching), auth/telemetry ingestion at scale, custom domains + TLS.
4. **Provisioning / self-host packaging** — Dockerfiles, compose, IaC; the open-source self-host story. **Infra — needs real targets.**

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
