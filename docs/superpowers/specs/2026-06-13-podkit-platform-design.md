# podkit — Platform Architecture & Design

**Date:** 2026-06-13
**Status:** Approved design (overarching architecture). Each pillar/phase gets its own spec → plan → build cycle.
**Working name:** podkit (rename TBD)

---

## 1. Vision

An **agents-first, humans-first-class** application platform — Vercel + Supabase class, with its own
Next.js-class framework — where an AI agent can go **idea → deployed, authed, data-backed app** in one
coherent, legible loop, and a human can watch and steer through a UI on top.

Reference point: [lakebed.dev](https://docs.lakebed.dev/) (Theo's agent-native "capsule" runtime) proves the
agents-first thesis at a small scale. podkit takes that thesis **upmarket** to a capable, integrated platform.

### Positioning decisions (locked)

| Axis | Decision |
|---|---|
| Primary user | **Agents-first, humans first-class.** Designed agent-first; humans get a UI on top of the same control-plane API. |
| Ambition | Real product / startup (small team). No layer ships weak ("never let a part lack"). |
| Build strategy | **Compose proven engines for commodity layers; build the differentiators deeply.** |
| Stack | **TypeScript end-to-end** (best agent legibility). Rust/Go only later if a hot path demands it. |
| Distribution | **Self-hostable + open-source, AND a managed cloud service** (Supabase model). |

### What you build deeply (the moat) vs compose

- **Build deeply:** the Framework, the CLI/control plane, Docs, and the **integration** that makes everything feel like one product.
- **Compose (don't reinvent the engine):** Postgres (DB), an auth core (Lucia/OpenAuth-style primitives), the microVM deploy runtime, the TS toolchain (Vite/Rolldown).

> Integration + DX is the product — exactly how Supabase (Postgres + GoTrue + PostgREST, integrated) and Vercel (framework + DX, not raw compute) actually won.

---

## 2. Architecture: one control plane, seven pillars

```
   AGENT ─►┌──────────────────────────────────────────────┐◄─ HUMAN
  (primary)│   podkit CLI — the agent's whole world         │  (CLI + dashboard)
           │   machine-readable, deterministic I/O          │
           └───────────────────────┬──────────────────────-┘
                                    │ one control-plane API
   ┌──────────┬──────────┬─────────┼─────────┬──────────┬──────────┐
   ▼          ▼          ▼         ▼         ▼          ▼          ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐
│FRAMEWORK││  DB    ││  AUTH  ││ DEPLOY ││OBSERV. ││ANALYT. ││  DOCS  │
│(crown) ││Postgres││ core   ││microVM ││logs/   ││events/ ││dual-   │
│SSR+route││schema- ││sessions││runtime ││traces/ ││funnels/││audience│
│RLS-aware││as-code ││orgs/RBAC││deploy ││errors  ││Web     ││+ proj. │
│typed RPC││+ RLS   ││agent id││protocol││(ops)   ││Vitals  ││docs    │
└────────┘└────────┘└────────┘└────────┘└────────┘└────────┘└────────┘
   └──────────── all expressed in one TypeScript project ────────────┘
```

- **Capability pillars (6):** Framework, DB, Auth, Deploy, Observability, Analytics.
- **Cross-cutting first-class pillar:** Docs (dual-audience: human site + machine-readable + auto-generated project docs).
- **Unifying surface:** the CLI / control plane. The dashboard is a *second client* of the same control-plane API — **no capability lives in only one client.**
- **Env layer:** per-variable sensitivity (see §10), spanning Deploy + CLI.

**The fusion (why it's one product):** the authenticated session (human *or* agent) auto-injects into framework
loaders/actions and flows straight into **DB RLS** → `auth → RLS → data` is one continuous, enforced chain.

---

## 3. Pillar: Framework (the crown jewel — "Next.js")

**View layer:** **React** (ecosystem, agent familiarity, best SSR/streaming tooling).

**Routing — file-based, convention over config:**
```
app/
  routes/
    index.tsx              →  /
    about.tsx              →  /about
    blog/[slug].tsx        →  /blog/:slug      (dynamic segment)
    docs/[...path].tsx     →  /docs/*           (catch-all)
    dashboard/
      _layout.tsx          →  nested layout wrapping children
      index.tsx            →  /dashboard
  server/                  →  server-only code (DB, auth, secrets)
  shared/                  →  types shared client⇄server (end-to-end typed)
```

**Rendering — SSR-first, modes per route:** every route is **SSR + streaming** by default (HTML on first byte,
hydrate after). A route opts into **static (SSG)** or **ISR** (cached + revalidate) via an export. One renderer,
three modes — not three hand-built pipelines.

**Data + server logic — typed RPC, agent-legible:** a route's server file exports typed loaders/actions; the
client calls them with **full end-to-end types**. The framework auto-injects an **RLS-aware DB client + the auth
session** — "logged-in user reads their rows" is the default, not wiring.

**Build:** Vite/Rolldown under the hood — fast dev server + HMR, optimized prod build. No hand-written bundler.

---

## 4. Pillar: DB (the "Supabase")

- **Engine:** real **Postgres** with **branching** (Neon-style copy-on-write) — every preview deploy gets an isolated DB branch.
- **Schema-as-code (TS, Drizzle-style):** tables/columns/relations defined in TypeScript; the primary authoring path; yields a typed query client.
- **Migrations as versioned files (first-class):** schema diffs generate timestamped DDL migration files you commit.
- **`podkit db pull` — bidirectional, no-drift:** introspects the live DB, captures out-of-band DDL (e.g. from the dashboard SQL editor) as new migration files **and** reconciles it back into the TS schema. No drift in either direction.
- **RLS — two tiers, no ceiling:**
  - **Convenience helpers** (`ownedBy(user)`, `inOrg()`, `isAgent()`) declared in TS → generated into real policies.
  - **Full custom policies** — arbitrary Postgres RLS expressions written directly, still versioned as migration files and captured by `db pull`.
- **Access paths (both):** typed query client (primary, for loaders/actions) **and** auto-generated REST + realtime (PostgREST-style) for direct/edge/external access.
- **Realtime (core):** subscribe to row changes (Postgres logical replication → websockets).
- **Studio:** `podkit db studio` (dashboard) with SQL editor — changes pullable via `db pull`.

---

## 5. Pillar: Auth

- **Core:** built on solid primitives (Lucia/OpenAuth-style) — sessions, secure cookies, JWTs, CSRF. No hand-rolled crypto.
- **Two first-class identity kinds (the differentiator):**
  - **Human users** — email/password, magic link, OAuth (Google, GitHub, …), passkeys. (Enterprise SSO/SAML = later.)
  - **Agent identities** — scoped service-account tokens; an agent acts *as itself* or *on behalf of a user*, with explicit, auditable scopes. Every agent action attributable in logs/analytics.
- **Multi-tenant org model (core, opt-in per app):** users → memberships → orgs/teams → roles (RBAC). Ships in core; an app may ignore it and be single-user.
- **Fusion:** the authenticated session is auto-injected into framework loaders/actions and flows into DB RLS (`auth.user_id`, `auth.org_id`, `auth.is_agent`).

---

## 6. Pillar: Deploy (the "Vercel")

- **Loop:** `podkit deploy` (or git push) → build the TS app (Vite/Rolldown) → static bundle (→ CDN) + server artifact (SSR, loaders, actions) → run.
- **Runtime:** **Node serverless on microVMs (Firecracker-style)** — full Node compatibility (every npm package, full SSR, server-side functions). **Edge (V8 isolates) is deferred** — can return later as an optional per-route mode; nothing in the design blocks it.
- **Immutable deployments:** every deploy is a permanent addressable version; promotion to prod is atomic; **rollback is instant** (re-point, no rebuild).
- **Preview deploys ↔ DB branches:** every branch/PR gets a preview URL **+ its own DB branch** (§4). Agents deploy a preview, test against isolated data, tear it down.
- **Domains & TLS:** custom domains, automatic TLS/DNS, per-deploy URLs.
- **Deploy protocol (agent-legible):** anonymous deploy → `claim` → owned deploy (lakebed's model, kept), extended with immutable versions, atomic promote, instant rollback, per-environment secrets synced via CLI.

---

## 7. Pillar: Observability + Analytics

Both = **telemetry the agent can query through the CLI**; different question + audience. Shared spine: every
event carries `deploy_version`, `request_id`/`trace_id`, and **identity (which human / which agent)** → fully attributable.

**Observability (ops / debugging — "why did this 500?"):**
- **Structured logs** (JSON) auto-captured from every server function (no logger setup).
- **Traces:** spans across request → loader/action → DB query.
- **Errors** grouped with stack traces; **metrics:** latency, error rate, cold starts.
- **Agent loop:** `podkit logs --since 1h --level error --route /blog/[slug]` → deterministic JSON; live `--tail`. Closes **deploy → observe → diagnose → fix** with no human.

**Analytics (product insight — "what do people use?"):**
- **Auto web analytics:** page views, sessions, referrers, **Web Vitals** — zero setup, privacy-friendly by default.
- **Custom events:** `track("signup", {...})` from client or server.
- **Funnels / retention** over events.
- **Agent loop:** `podkit analytics query ...`; human sees it in the dashboard.

Both write to one telemetry store, queryable by CLI (agent) and dashboard (human).

---

## 8. Pillar: Docs (cross-cutting, first-class — a runtime interface)

In an agents-first platform, docs are how the agent learns the platform. Bad docs → broken agent code → thesis fails.

1. **Platform docs — one source, two renders, never drift:**
   - **Human:** beautiful, searchable docs site — guides, examples, API reference.
   - **Agent:** same content machine-readable — `podkit docs <topic>` returns structured markdown/JSON; an `llms.txt` manifest; every CLI command self-documents (`--help` complete + structured). **Pinned to the exact platform/CLI version.**
2. **Auto-generated project docs (the superpower):** every podkit app gets always-current generated docs of *its own* surface — schema, every route/URL, every typed RPC endpoint, auth/RBAC model, env vars. `podkit docs project` → an agent dropped cold understands the project instantly. **Self-describing apps.**
3. **Tested examples:** every doc code sample runs in CI so docs can't rot.

---

## 9. The unifying surface: CLI / Control Plane

**Model:** one **control-plane API** over all seven pillars. The **CLI is its primary client (the agent's whole
world); the dashboard is a second client of the same API.** Anything a human can click, an agent can do via CLI,
and vice-versa.

**Agents-first CLI design rules (the craft):**
- **`--json` everywhere**, stable versioned output schemas — deterministic, parseable.
- **Structured errors:** code + machine-readable detail + remediation hint ("run `podkit db pull`"). Agents recover instead of flailing.
- **Idempotent** where possible; clear exit codes; streamable (`--tail`).
- **Self-documenting:** `--help` complete + structured; `podkit docs` built in.

**Command tree (across all pillars):**
```
podkit dev                 # full stack locally: framework + Postgres + auth + emulated obs
podkit deploy / promote / rollback / claim
podkit db   migrate | pull | branch | studio
podkit auth providers | tokens | orgs
podkit logs        --tail --level --route        (observability)
podkit analytics   query | events
podkit secrets | domains
podkit docs        <topic> | project
```

**Local = cloud parity:** `podkit dev` runs the *entire* stack locally (real Postgres, auth, framework dev
server, emulated deploy/telemetry) → identical surfaces locally and deployed.

---

## 10. Env / Secrets layer

- **Per-variable sensitivity flag (Vercel-style):**
  - **Sensitive** — encrypted at rest, **write-only**: after set, the value is *never* returned again by CLI, dashboard, or API (rotate/replace only). Existence visible, value not. For keys/tokens/creds.
  - **Plain** — readable again by CLI/dashboard, for non-secret config (public URLs, feature flags, log levels).
- **Per-environment** (dev / preview / prod), synced via `podkit secrets`/env commands, injected at runtime.
- **Audit:** every change attributed to a human/agent identity.

---

## 11. Build order

The full design above **is the v1 target** — no layer ships weak. It's built in a sane sequence. The platform is
**too big for one implementation plan**, so this doc is the overarching architecture; each pillar/phase gets its
own spec → plan → build cycle.

**Phase 0 — The Spine (prove the integrated thesis end-to-end):**
one app, locally + deployed, exercising every pillar *thinly but really*:
file-routed SSR page → typed loader → authed session (email/pw + agent token) → one RLS-protected table
(TS schema + migration file) → deployed on the microVM runtime with rollback → structured logs queryable by CLI →
one page-view analytic → machine-readable docs + `docs project`. **This is the "it's one product" proof.**

**Then deepen each pillar to capable (own spec+plan each):**
1. **Framework** — full routing (dynamic/catch-all/layouts), SSR streaming, static/ISR modes, RPC types
2. **DB** — branching, realtime, `db pull`, custom RLS, studio
3. **Deploy** — preview deploys ↔ DB branches, domains/TLS, immutable+promote
4. **Auth** — full provider set, orgs/RBAC, agent scopes
5. **Observability + Analytics** — traces, funnels, retention
6. **CLI/Docs** — full command tree, `--json` everywhere, docs site
7. **Cloud + self-host packaging**

**Build deeply (moat):** Framework, CLI/control plane, Docs, integration.
**Compose:** Postgres, auth core, microVM runtime, TS toolchain.

---

## 12. Open questions / deferred

- Final product **name** (working name: podkit).
- Underlying cloud provider for the managed service (AWS / GCP / Fly / other).
- Specific auth-core library (Lucia vs OpenAuth vs custom-on-primitives).
- Edge runtime (deferred — optional per-route mode post-core).
- Enterprise SSO/SAML (post-core).
- Pricing / billing model (out of scope for this design).
