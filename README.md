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
