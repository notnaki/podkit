import { createHmac, timingSafeEqual } from "node:crypto";

function base64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function computeSig(body: string, secret: string): string {
  const raw = createHmac("sha256", secret).update(body).digest();
  return Buffer.from(raw).toString("base64url");
}

export function signToken(
  payload: Record<string, unknown>,
  secret: string
): string {
  const body = base64url(JSON.stringify(payload));
  const sig = computeSig(body, secret);
  return `${body}.${sig}`;
}

export function verifyToken(
  token: string,
  secret: string
): Record<string, unknown> | null {
  try {
    const dotIndex = token.indexOf(".");
    if (dotIndex === -1) return null;

    const body = token.slice(0, dotIndex);
    const sig = token.slice(dotIndex + 1);

    if (!body || !sig) return null;

    const expected = computeSig(body, secret);

    const sigBuf = Buffer.from(sig, "base64url");
    const expectedBuf = Buffer.from(expected, "base64url");

    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

    const decoded = Buffer.from(body, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function issueAgentToken(
  payload: { userId: string; scopes: string[] },
  secret: string
): string {
  return signToken({ ...payload, kind: "agent" }, secret);
}
