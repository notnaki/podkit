// A cookie an `action` asks the server to set. Defaults are security-minded:
// HttpOnly on, SameSite=Lax, Path=/, and Secure in production. Set value to ""
// with maxAge: 0 to clear a cookie.
export interface CookieDirective {
  name: string;
  value: string;
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
}

/**
 * Serialize a CookieDirective to a Set-Cookie header value. The value is
 * percent-encoded; the framework's cookie reader (extractToken) decodes it, so
 * arbitrary values round-trip safely.
 */
export function serializeCookie(c: CookieDirective): string {
  const parts: string[] = [`${c.name}=${encodeURIComponent(c.value)}`];
  parts.push(`Path=${c.path ?? "/"}`);
  if (c.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(c.maxAge)}`);
  if (c.httpOnly ?? true) parts.push("HttpOnly");
  parts.push(`SameSite=${c.sameSite ?? "Lax"}`);
  if (c.secure ?? process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}
