# Upload-based deploy

`podkit cloud deploy <slug>` packages your project into a gzipped tarball and
**streams it to the control plane**, which extracts it into an isolated
directory, builds it, and routes it — no shared filesystem between the CLI and
the control plane is required. This is the path you use to deploy to a remote
podkit cloud (the older local-path `POST /v1/projects/:slug/deploy` remains for
co-located/operator use and still works).

## Flow

```
podkit cloud deploy myapp
  └─ tar -czf - --exclude=node_modules --exclude=.git --exclude=.podkit/dist .
       │  (streamed, never buffered in memory)
       ▼
  POST /v1/projects/myapp/deploy-upload   Content-Type: application/gzip
       │  Authorization: Bearer <token>   (or x-podkit-key: <key>)
       ▼
  control plane:
    1. guard credentials                 -> 401 if missing/invalid
    2. resolve project                   -> 404 if unknown
    3. enforce ownership                  -> 401 / 403 ladder
    4. stream body to a fresh temp dir    -> 413 if > 500 MiB
    5. extract with path-traversal audit  -> 400 if malicious/corrupt
    6. build (Dockerfile or buildpack) + run + route
       │  (temp dir ALWAYS removed afterward)
       ▼
  -> { version, hostPort, url }
```

## Tarball format

- A standard gzipped tarball (`application/gzip`) of your build context.
- Paths are **relative** (the CLI runs `tar -C <contextDir> .`). The control
  plane rejects any entry that is an absolute path, contains a `..` segment, or
  is a symlink whose target escapes the extraction directory.
- The CLI excludes `node_modules`, `.git`, and `.podkit/dist` by default to keep
  the upload small (well under the 500 MiB server cap). Dependencies are
  installed during the image build, so they do not need to be in the tarball.

## Dockerfile vs buildpack

- **Dockerfile app:** if the build context (or `--appSubpath`) contains a
  `Dockerfile`, the app is **self-contained** — `docker build <extractedDir>`
  works immediately. This is the simplest, fully-portable path.
- **Buildpack (zero-config) app:** an app with no Dockerfile but an `app/routes`
  directory is built with the podkit buildpack, which requires the **full pnpm
  monorepo** (`packages/cli`, `packages/*/package.json`, etc.). You must upload a
  tarball containing the monorepo at the repo root with the app under a subpath,
  and pass `--appSubpath=apps/myapp`. If the monorepo is incomplete, the build
  fails with a clear error: `no Dockerfile and not a podkit app`.

## appSubpath

`--appSubpath=apps/myapp` tells the control plane to build the app at that
subpath within the extracted tarball. It is sent as a query parameter
(`?appSubpath=apps/myapp`), validated as a safe relative path (no leading `/`, no
`..` segments), and joined onto the extracted dir. For a Dockerfile app it
selects the build context; for a buildpack app it selects the app within the
uploaded monorepo.

## CLI flags

```
podkit cloud deploy <slug> [--contextDir=<dir>] [--containerPort=<port>] [--appSubpath=apps/myapp]
```

- `--contextDir` — directory to package (default: current working directory).
- `--containerPort` — port your app listens on inside the container
  (default: `$PODKIT_APP_PORT` or `3000`).
- `--appSubpath` — app location within the tarball (see above).

## Errors

- **413** — the upload exceeded the 500 MiB cap. Remove large files or rely on
  the default excludes. The CLI surfaces a friendly hint.
- **400** — the server rejected the tarball (malformed gzip, absolute/`..`
  entry, escaping symlink). Repack and retry.
- **401 / 403 / 404** — credentials missing/invalid, not the project owner, or
  unknown project.

## Operator: builds root

Uploaded tarballs are streamed and extracted under, in order of preference:

1. `PODKIT_BUILDS_ROOT` (if set) — the same dedicated, quota-enforced volume used
   for local-path build contexts. **Recommended in production.**
2. `PODKIT_CONTROL_PLANE_ROOT/builds` (if `PODKIT_CONTROL_PLANE_ROOT` is set).
3. The OS temp dir (`<tmpdir>/podkit-builds`) as a last resort.

The control plane creates per-`projectId` subdirectories automatically; the
operator only needs to ensure the chosen root exists and is writable. Each
upload extracts into a unique subdirectory and is **always removed** after the
build (success or failure). Because a tarball can expand to far more than its
compressed size (a "tar bomb"), point `PODKIT_BUILDS_ROOT` at a volume with
OS-level disk quota.

## Security model (summary)

- **Streaming + size cap:** the body is piped straight to disk with a 500 MiB
  guard, so an oversized/malicious upload never buffers in control-plane memory
  (413 on overflow) and Node backpressure throttles a fast client.
- **Path-traversal defense:** a pre-flight `tar -tzf` listing audit rejects
  absolute and `..` entries before any file is written; extraction omits the
  unsafe `-P`/`--absolute-names` flag; a post-extract pass `realpath`-resolves
  every entry (collapsing symlinks and `..`) and rejects anything that escapes
  the extraction dir, including symlinks pointing outside.
- **Guaranteed cleanup:** the per-upload temp dir (tarball + extracted tree) is
  removed in a `finally` block regardless of outcome.
- **Tenant code isolation:** a malicious Dockerfile only executes inside the
  container sandbox (`--cap-drop ALL`, `--security-opt no-new-privileges`,
  memory/cpu/pids limits, `127.0.0.1`-only port binding).
