# Deploying the podkit cloud

The podkit cloud (control-plane + gateway + Postgres) builds and runs your
tenants' app containers via the host **Docker** daemon. So it deploys to a
**Docker-capable VM** — not a serverless/PaaS that hides the Docker socket.

- **MVP (today): one VM with Docker.** Hetzner, DigitalOcean, Fly.io (a Machine
  with Docker), AWS EC2, GCP Compute Engine, or any box you control. The whole
  cloud runs from one compose file; the gateway routes all tenant traffic.
- **Multi-node / autoscale (later):** requires moving builds+runs off the mounted
  Docker socket to a brokered build service or an orchestrator (k8s/Nomad). See
  `docs/ROADMAP.md` ("docker.sock host-escape").

## 1. Provision a host

Any Linux VM with Docker Engine + Compose v2. Size to your workload (each tenant
app is a container; each project gets its own Postgres database). A 2 vCPU /
4 GB box is a fine starting point. Open inbound **80/443** (and **22**).

```sh
# On the VM (Debian/Ubuntu):
curl -fsSL https://get.docker.com | sh
```

## 2. Get the code + secrets

```sh
git clone https://github.com/notnaki/podkit.git && cd podkit
cp infra/.env.example infra/.env
# Generate the two crypto keys:
openssl rand -hex 32   # -> PODKIT_AUTH_SECRET
openssl rand -hex 32   # -> PODKIT_SECRETS_KEY
# Then edit infra/.env and fill in POSTGRES_PASSWORD, PODKIT_API_KEY,
# PODKIT_CONSOLE_URL (e.g. https://cloud.example.com), PODKIT_CORS_ORIGINS.
```

`infra/.env` is gitignored. The control-plane runs with `NODE_ENV=production`
and **refuses to boot** with insecure dev-default secrets, so these must be set.

## 3. Boot

```sh
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env up -d --build
curl -s http://localhost:8080/v1/health   # {"ok":true,...}
```

This starts Postgres (persistent `pgdata` volume), the control-plane (console +
API on **8080**), and the gateway (deployed apps on **8090**), all
`restart: unless-stopped`.

## 4. TLS + DNS (recommended)

The control-plane serves plain HTTP. Front it with a TLS terminator and point
DNS at the VM:

- Set `PODKIT_API_BIND=127.0.0.1:8080` and `PODKIT_GATEWAY_BIND=127.0.0.1:8090`
  in `infra/.env` so only the proxy is exposed.
- Run **Caddy** (auto-HTTPS) or Traefik/nginx on the host:
  - `cloud.example.com` → `127.0.0.1:8080` (console + API)
  - `*.example.com` / your app domains → `127.0.0.1:8090` (gateway). The gateway
    routes by `Host` header to the matching project (see custom domains), and by
    path via `/_p/<slug>`.

Example Caddyfile:

```
cloud.example.com {
    reverse_proxy 127.0.0.1:8080
}
*.apps.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

(Automated per-domain cert issuance from podkit itself — ACME — is on the
roadmap; until then the terminator handles TLS.)

## 5. First login

Open `https://cloud.example.com`, sign up, and you're in. From the CLI:

```sh
podkit cloud login --url https://cloud.example.com
podkit cloud create my-app
podkit cloud deploy my-app          # from the app directory
```

## Operations

- **Backups:** the only stateful piece is the `pgdata` volume (control-plane DB
  **and** the per-project databases live in this Postgres). Back it up with
  `pg_dumpall` or volume snapshots.
- **Upgrades:** `git pull && docker compose -f infra/docker-compose.prod.yml --env-file infra/.env up -d --build`.
- **Logs:** `docker compose -f infra/docker-compose.prod.yml logs -f controlplane`.
- **Teardown:** `docker compose -f infra/docker-compose.prod.yml down`
  (add `-v` to also drop the database volume — destroys all data).

## Security notes (already enforced)

- Per-project **scoped Postgres roles** (tenants never get superuser creds).
- **Secrets encrypted at rest** (env vars + scoped DB creds) with
  `PODKIT_SECRETS_KEY`.
- **Per-project ownership** on every API endpoint; bearer tokens carry expiry +
  revocation.
- Tenant containers run **non-root**, `--cap-drop ALL`, `--security-opt
  no-new-privileges`, CPU/mem/pids limits, ports bound to localhost.

See `docs/ROADMAP.md` for the remaining hardening items (secret-injection
redesign, docker.sock escape, ACME TLS).
