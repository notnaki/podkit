// Single source of truth for resolving the secrets-at-rest encryption key used
// to encrypt project ENV values in the store. Mirrors resolveAuthSecret: in
// production an unset key is a fatal misconfiguration — encrypting with a public
// default would defeat the point — so we refuse. In dev we warn and return a
// sentinel so the caller can keep storing plaintext (backward compatible).

// Sentinel returned in dev when PODKIT_SECRETS_KEY is unset. Callers MUST check
// for this before encrypting: when the key is unset, encryption is disabled and
// values are stored as plaintext (existing behaviour).
export const SECRETS_KEY_UNSET = null;

// Resolves the 32-byte (256-bit) AES key from PODKIT_SECRETS_KEY, expressed as
// 64 hex characters. Returns SECRETS_KEY_UNSET (null) in dev when the key is
// absent so the caller can fall back to plaintext storage.
export function resolveSecretsKey(): Buffer | null {
  const fromEnv = process.env.PODKIT_SECRETS_KEY;
  if (!fromEnv) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PODKIT_SECRETS_KEY is required in production (refusing to encrypt secrets with no key)",
      );
    }
    console.warn(
      "[podkit] PODKIT_SECRETS_KEY not set — secrets-at-rest encryption disabled; values stored as plaintext (never do this in production)",
    );
    return SECRETS_KEY_UNSET;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    throw new Error(
      "PODKIT_SECRETS_KEY must be exactly 64 hex characters (32 bytes)",
    );
  }
  return Buffer.from(fromEnv, "hex");
}
