import { createHmac, timingSafeEqual } from "node:crypto";

// Encode bytes as base64url (no padding, URL-safe chars). node:crypto's built-in
// "base64url" encoding produces this directly.
function toBase64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// Compute HMAC-SHA256 of the canonical blob descriptor:
//   "<projectId>:<key>:<expMs>"
// Using the binary HMAC output (not hex) keeps the token shorter.
function hmac(projectId: string, key: string, expMs: number, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${projectId}:${key}:${expMs}`)
    .digest();
}

// Sign a blob reference. Returns a base64url-encoded HMAC-SHA256 token.
// expMs is the absolute expiry time in milliseconds since epoch.
// ponytail: no nonce, so two calls with same args produce the same token.
// Upgrade: add a random nonce to the payload for one-time-use semantics.
export function signBlob(
  projectId: string,
  key: string,
  expMs: number,
  secret: string,
): string {
  return toBase64url(hmac(projectId, key, expMs, secret));
}

// Verify a blob token. Returns true only if:
//   1. The HMAC matches (constant-time compare).
//   2. nowMs < expMs (strict: expired at the boundary second).
export function verifyBlob(
  projectId: string,
  key: string,
  expMs: number,
  sig: string,
  secret: string,
  nowMs: number,
): boolean {
  if (nowMs >= expMs) return false;
  const expected = hmac(projectId, key, expMs, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
