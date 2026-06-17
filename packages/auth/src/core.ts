import { randomUUID, randomBytes, createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import type { DbClient } from "@podkit/db";
import {
  users,
  sessions,
  passwordResetTokens,
  emailVerifyTokens,
} from "./schema.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import {
  signToken,
  verifyToken,
  issueAgentToken as issueAgentTokenFromToken,
} from "./token.ts";
import { sendEmail } from "./email.ts";

export interface Identity {
  userId: string;
  isAgent: boolean;
  scopes?: string[];
}

// Default session TTL: 30 days. Configurable via createAuth({ sessionTtlSeconds }).
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Reset / verification tokens are short-lived single-use links.
const DEFAULT_RESET_TTL_SECONDS = 60 * 60; // 1 hour
const DEFAULT_VERIFY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Hash a bearer-style secret (reset/verify token) for storage at rest. SHA-256
// is sufficient here: the token is a 256-bit random value (not a low-entropy
// password), so it needs no salt/KDF — an attacker with the DB can't reverse a
// random 32-byte preimage, and constant-time compare isn't needed because we
// look the row up BY the hash (no secret-dependent branch on a known row).
function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createAuth(opts: {
  db: DbClient["db"];
  secret: string;
  sessionTtlSeconds?: number;
  resetTtlSeconds?: number;
  verifyTtlSeconds?: number;
}) {
  const { db, secret } = opts;
  const sessionTtl = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const resetTtl = opts.resetTtlSeconds ?? DEFAULT_RESET_TTL_SECONDS;
  const verifyTtl = opts.verifyTtlSeconds ?? DEFAULT_VERIFY_TTL_SECONDS;

  async function signup({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ userId: string }> {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));

    if (existing.length > 0) {
      throw new Error("email already registered");
    }

    const userId = randomUUID();
    const passwordHash = hashPassword(password);

    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
    });

    // Issue an email-verification token and "send" it via the dev sink. Signup
    // is NOT blocked on verification (see resolveSession/login comments).
    await issueEmailVerification(userId, email);

    return { userId };
  }

  async function login({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ token: string }> {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, email));

    const user = rows[0];

    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new Error("invalid credentials");
    }

    // ponytail: login does NOT require user.emailVerified — keeping signup
    //   immediately usable. Upgrade path: reject here when !user.emailVerified
    //   (and add a resend-verification flow) to hard-gate on a verified email.

    const token = signToken({ userId: user.id, kind: "session" }, secret);
    return { token };
  }

  // Create a table-backed session and return its bearer token. The token's jti
  // IS the sessions.id, so resolveSession() can look the row up and enforce
  // expiry + revocation. TTL is stamped both into the token (exp) and the row
  // (expiresAt) so either layer alone rejects an expired session.
  async function createSession(userId: string): Promise<{ token: string; sessionId: string }> {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + sessionTtl * 1000);
    await db.insert(sessions).values({
      id: sessionId,
      userId,
      expiresAt,
      createdAt: new Date(),
    });
    const token = signToken(
      { userId, kind: "session", jti: sessionId },
      secret,
      sessionTtl,
    );
    return { token, sessionId };
  }

  // Resolve a session token against the sessions table: verify the signature,
  // then reject the session if its row is missing, revoked, or past expiresAt.
  // Backward-tolerant: a row with a NULL expiresAt is treated as non-expiring.
  async function resolveSession(token: string): Promise<Identity | null> {
    const payload = verifyToken(token, secret);
    if (!payload) return null;
    const userId = payload["userId"];
    if (typeof userId !== "string") return null;
    const jti = payload["jti"];
    if (typeof jti !== "string") return null;

    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, jti));
    const row = rows[0];
    if (!row) return null;
    // Revoked sessions are rejected even if not yet expired.
    if (row.revokedAt) return null;
    // NULL expiresAt => legacy/non-expiring; otherwise enforce it.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    return { userId, isAgent: false, scopes: undefined };
  }

  // Revoke a session by id (idempotent). Returns true if a live session was
  // affected. We mark revokedAt rather than delete so an audit trail survives;
  // expired rows can be GC'd separately.
  async function revokeSession(sessionId: string): Promise<boolean> {
    const result = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return result.length > 0;
  }

  // Revoke every live session for a user (used after a password reset).
  async function revokeAllSessions(userId: string): Promise<number> {
    const result = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return result.length;
  }

  function verifySession(token: string): Identity | null {
    const payload = verifyToken(token, secret);
    if (!payload) return null;

    const userId = payload["userId"];
    if (typeof userId !== "string") return null;

    const kind = payload["kind"];
    const isAgent = kind === "agent";
    const rawScopes = payload["scopes"];
    const scopes = Array.isArray(rawScopes)
      ? (rawScopes as string[])
      : undefined;

    return { userId, isAgent, scopes };
  }

  function issueAgentToken(
    {
      userId,
      scopes,
    }: {
      userId: string;
      scopes: string[];
    },
    ttlSeconds?: number
  ): string {
    return issueAgentTokenFromToken({ userId, scopes }, secret, ttlSeconds);
  }

  // --- Password reset ---------------------------------------------------------

  // Issue a single-use, expiring reset token (stored hashed) and email the
  // plaintext to the user. Returns the plaintext token so callers/tests can
  // exercise the flow; the HTTP layer must NOT echo it back to the requester
  // (always 200 to avoid email enumeration).
  async function requestPasswordReset(
    email: string,
  ): Promise<{ sent: boolean; token?: string }> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    const user = rows[0];
    // Unknown email: report success without sending (anti-enumeration).
    if (!user) return { sent: false };

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + resetTtl * 1000);
    await db.insert(passwordResetTokens).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash,
      expiresAt,
      createdAt: new Date(),
    });

    await sendEmail({
      to: email,
      subject: "Reset your podkit password",
      text: `Use this token to reset your password: ${token}\n(Expires in ${Math.round(resetTtl / 60)} minutes.)`,
    });

    return { sent: true, token };
  }

  // Validate + consume a reset token: must exist (by hash), be unexpired and
  // unused. On success: updates the password hash, marks the token used
  // (single-use), and revokes all of the user's existing sessions.
  async function resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ ok: boolean }> {
    const tokenHash = hashOpaqueToken(token);
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash));
    const row = rows[0];
    if (!row) throw new Error("invalid or expired reset token");
    if (row.usedAt) throw new Error("invalid or expired reset token");
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new Error("invalid or expired reset token");
    }

    const passwordHash = hashPassword(newPassword);
    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, row.userId));

    // Single-use: consume the token so it can never be replayed.
    await db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, row.id));

    // Invalidate every existing session — a reset implies credential compromise.
    await revokeAllSessions(row.userId);

    return { ok: true };
  }

  // --- Email verification -----------------------------------------------------

  // Issue an email-verify token (hashed at rest) and "send" the plaintext.
  // Returns the plaintext for tests; the HTTP layer should not echo it.
  async function issueEmailVerification(
    userId: string,
    email: string,
  ): Promise<{ token: string }> {
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + verifyTtl * 1000);
    await db.insert(emailVerifyTokens).values({
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt,
      createdAt: new Date(),
    });
    await sendEmail({
      to: email,
      subject: "Verify your podkit email",
      text: `Use this token to verify your email: ${token}\n(Expires in ${Math.round(verifyTtl / 3600)} hours.)`,
    });
    return { token };
  }

  // Validate + consume an email-verify token and flip users.emailVerified.
  async function verifyEmail(token: string): Promise<{ ok: boolean }> {
    const tokenHash = hashOpaqueToken(token);
    const rows = await db
      .select()
      .from(emailVerifyTokens)
      .where(eq(emailVerifyTokens.tokenHash, tokenHash));
    const row = rows[0];
    if (!row) throw new Error("invalid or expired verification token");
    if (row.usedAt) throw new Error("invalid or expired verification token");
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new Error("invalid or expired verification token");
    }

    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, row.userId));
    await db
      .update(emailVerifyTokens)
      .set({ usedAt: new Date() })
      .where(eq(emailVerifyTokens.id, row.id));

    return { ok: true };
  }

  return {
    signup,
    login,
    verifySession,
    issueAgentToken,
    createSession,
    resolveSession,
    revokeSession,
    revokeAllSessions,
    requestPasswordReset,
    resetPassword,
    issueEmailVerification,
    verifyEmail,
  };
}
