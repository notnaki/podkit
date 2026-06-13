// Single source of truth for resolving the token-signing secret across every
// podkit client (CLI, control-plane server, ...). In production an unset secret
// is a fatal misconfiguration — falling back to a public constant would let
// anyone forge tokens — so we refuse. In dev we warn and use a known default.
export function resolveAuthSecret(): string {
  const fromEnv = process.env.PODKIT_AUTH_SECRET;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PODKIT_AUTH_SECRET is required in production (refusing to sign tokens with a public default)",
    );
  }
  console.warn(
    "[podkit] PODKIT_AUTH_SECRET not set — using an insecure dev default; never use this in production",
  );
  return "podkit-dev-secret";
}
