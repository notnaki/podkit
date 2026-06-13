import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const colonIndex = stored.indexOf(":");
    if (colonIndex === -1) return false;

    const saltHex = stored.slice(0, colonIndex);
    const hashHex = stored.slice(colonIndex + 1);

    if (saltHex.length === 0 || hashHex.length === 0) return false;

    const salt = Buffer.from(saltHex, "hex");
    const storedHash = Buffer.from(hashHex, "hex");

    const derivedHash = scryptSync(plain, salt, 64);

    if (derivedHash.length !== storedHash.length) return false;

    return timingSafeEqual(derivedHash, storedHash);
  } catch {
    return false;
  }
}
