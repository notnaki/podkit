import { timingSafeEqual } from "node:crypto";

/**
 * Guard for mutating cloud operations behind a shared API key.
 *
 * @param headers Incoming request headers (values may be string, string[], or undefined).
 * @param expected The configured API key. If falsy/empty, no key is configured and the
 *   request is denied (fail closed).
 * @returns true only when the `x-podkit-key` header exactly matches `expected`.
 */
export function requireApiKey(
  headers: Record<string, string | string[] | undefined>,
  expected: string | undefined,
): boolean {
  // No key configured -> deny mutating ops.
  if (!expected) return false;

  const raw = headers["x-podkit-key"];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (typeof provided !== "string" || provided.length === 0) return false;

  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on length mismatch; guard it ourselves.
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}
