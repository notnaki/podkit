/**
 * Shared CORS allowlist helpers for the podkit control-plane.
 *
 * Backward-compatible by design: when no allowlist is configured (env var
 * unset) the control-plane keeps its historic permissive "*" behavior. Once an
 * allowlist is supplied, only Origins on the list have their value reflected
 * back, and responses are marked `Vary: Origin` so caches don't leak a
 * per-origin response to a different origin.
 */

/**
 * Parse a comma-separated allowlist of origins from an env var value.
 *
 * @param envValue The raw env var value, or undefined when unset.
 * @returns null when the value is undefined (meaning: use "*" wildcard), or an
 *   array of trimmed, non-empty origins otherwise (possibly empty).
 */
export function parseCorsOrigins(envValue: string | undefined): string[] | null {
  // Unset -> no restriction (preserve the permissive wildcard default).
  if (envValue === undefined) return null;
  return envValue
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Resolve the `Access-Control-Allow-Origin` value for a single request.
 *
 * @param requestOrigin The incoming `Origin` header, or undefined when absent.
 * @param allowedOrigins The parsed allowlist (null = wildcard, no restriction).
 * @returns `origin`: the value to send for `Access-Control-Allow-Origin`, or
 *   null to omit the header entirely. `vary`: whether `Vary: Origin` should be
 *   set (true whenever an allowlist is active, so caches stay correct).
 */
export function resolveCorsHeader(
  requestOrigin: string | undefined,
  allowedOrigins: string[] | null,
): { origin: string | null; vary: boolean } {
  // No allowlist configured -> permissive wildcard, no Vary needed.
  if (allowedOrigins === null) return { origin: "*", vary: false };
  // Case-sensitive match per the CORS spec.
  if (requestOrigin !== undefined && allowedOrigins.includes(requestOrigin)) {
    return { origin: requestOrigin, vary: true };
  }
  return { origin: null, vary: true };
}
