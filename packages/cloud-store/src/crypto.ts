import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Self-describing envelope for encrypted ENV values. The "enc:v1:" prefix lets
// us distinguish ciphertext from legacy plaintext rows and leaves room for
// future algorithm/version changes (enc:v2:, ...). Absence of the prefix means
// the value is legacy plaintext and must pass through untouched.
const PREFIX = "enc:v1:";
const IV_LEN = 12; // AES-GCM standard nonce length.
const TAG_LEN = 16; // AES-GCM auth tag length.

// Encrypts plaintext with AES-256-GCM under `key` (32 bytes). Returns
// "enc:v1:" + base64(iv | authTag | ciphertext). A fresh random IV per value
// prevents pattern leakage across rows.
export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

// Decrypts a value produced by encryptValue. Values without the "enc:v1:"
// prefix are treated as legacy plaintext and returned as-is. On any decryption
// error (e.g. wrong key, tampered data) the raw stored value is returned so the
// caller degrades gracefully rather than throwing.
export function decryptValue(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(PREFIX)) return encrypted;
  try {
    const payload = Buffer.from(encrypted.slice(PREFIX.length), "base64");
    const iv = payload.subarray(0, IV_LEN);
    const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = payload.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return encrypted;
  }
}
