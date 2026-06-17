import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@podkit/db";
import { createAuth } from "../src/core.ts";
import { setEmailSender, resetEmailSender } from "../src/email.ts";

const client = createDbClient();

// Capture every "sent" email so we can assert on delivery + pull tokens the way
// a real reset/verify flow would (the HTTP layer never echoes tokens back).
const sent: Array<{ to: string; subject: string; text: string }> = [];

beforeAll(async () => {
  setEmailSender((msg) => {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
  });
  await client.raw(
    `CREATE TABLE users (
       id uuid PRIMARY KEY,
       email text UNIQUE NOT NULL,
       password_hash text,
       email_verified boolean NOT NULL DEFAULT false,
       created_at timestamptz
     )`,
  );
  await client.raw(
    `CREATE TABLE sessions (
       id uuid PRIMARY KEY,
       user_id uuid,
       expires_at timestamptz,
       revoked_at timestamptz,
       created_at timestamptz
     )`,
  );
  await client.raw(
    `CREATE TABLE password_reset_tokens (
       id uuid PRIMARY KEY,
       user_id uuid NOT NULL,
       token_hash text NOT NULL UNIQUE,
       expires_at timestamptz NOT NULL,
       used_at timestamptz,
       created_at timestamptz
     )`,
  );
  await client.raw(
    `CREATE TABLE email_verify_tokens (
       id uuid PRIMARY KEY,
       user_id uuid NOT NULL,
       token_hash text NOT NULL UNIQUE,
       expires_at timestamptz NOT NULL,
       used_at timestamptz,
       created_at timestamptz
     )`,
  );
});

afterAll(async () => {
  resetEmailSender();
  await client.close();
});

const auth = createAuth({ db: client.db, secret: "lifecycle-secret" });

describe("session expiry + revocation", () => {
  it("resolves a fresh session", async () => {
    const { userId } = await auth.signup({
      email: "sess@example.com",
      password: "password123",
    });
    const { token, sessionId } = await auth.createSession(userId);
    const identity = await auth.resolveSession(token);
    expect(identity).toEqual({ userId, isAgent: false, scopes: undefined });
    expect(typeof sessionId).toBe("string");
  });

  it("rejects a session past its expiresAt", async () => {
    const { userId } = await auth.signup({
      email: "expired@example.com",
      password: "password123",
    });
    const { token, sessionId } = await auth.createSession(userId);
    // Backdate the row's expiry so the table-layer check rejects it.
    await client.raw(
      `UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [sessionId],
    );
    expect(await auth.resolveSession(token)).toBeNull();
  });

  it("rejects a revoked session", async () => {
    const { userId } = await auth.signup({
      email: "revoked@example.com",
      password: "password123",
    });
    const { token, sessionId } = await auth.createSession(userId);
    expect(await auth.resolveSession(token)).not.toBeNull();
    const revoked = await auth.revokeSession(sessionId);
    expect(revoked).toBe(true);
    expect(await auth.resolveSession(token)).toBeNull();
    // Idempotent: revoking again affects nothing.
    expect(await auth.revokeSession(sessionId)).toBe(false);
  });
});

describe("password reset", () => {
  it("happy path: reset token updates password and revokes sessions", async () => {
    const { userId } = await auth.signup({
      email: "reset@example.com",
      password: "oldpassword1",
    });
    const { token: sessionToken, sessionId } = await auth.createSession(userId);

    const { sent: ok, token } = await auth.requestPasswordReset(
      "reset@example.com",
    );
    expect(ok).toBe(true);
    expect(typeof token).toBe("string");

    // Token is stored HASHED, never in plaintext.
    const rows = (await client.raw(
      `SELECT token_hash FROM password_reset_tokens WHERE user_id = $1`,
      [userId],
    )) as Array<{ token_hash: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    await auth.resetPassword(token!, "newpassword2");

    // Old password no longer works; new one does.
    await expect(
      auth.login({ email: "reset@example.com", password: "oldpassword1" }),
    ).rejects.toThrow("invalid credentials");
    const relogin = await auth.login({
      email: "reset@example.com",
      password: "newpassword2",
    });
    expect(typeof relogin.token).toBe("string");

    // Existing session was revoked by the reset.
    expect(await auth.resolveSession(sessionToken)).toBeNull();
    expect(sessionId).toBeTruthy();
  });

  it("rejects a reused (single-use) reset token", async () => {
    await auth.signup({ email: "reuse@example.com", password: "password123" });
    const { token } = await auth.requestPasswordReset("reuse@example.com");
    await auth.resetPassword(token!, "freshpass123");
    await expect(auth.resetPassword(token!, "another123")).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("rejects an expired reset token", async () => {
    const { userId } = await auth.signup({
      email: "rexpire@example.com",
      password: "password123",
    });
    const { token } = await auth.requestPasswordReset("rexpire@example.com");
    await client.raw(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
      [userId],
    );
    await expect(auth.resetPassword(token!, "whatever123")).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("rejects a wrong/unknown reset token", async () => {
    await expect(
      auth.resetPassword("deadbeef".repeat(8), "whatever123"),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("does not send for an unknown email (anti-enumeration)", async () => {
    const before = sent.length;
    const res = await auth.requestPasswordReset("nobody@example.com");
    expect(res.sent).toBe(false);
    expect(sent.length).toBe(before);
  });
});

describe("email verification", () => {
  it("signup issues a verify token and verifyEmail flips the flag", async () => {
    const { userId } = await auth.signup({
      email: "verify@example.com",
      password: "password123",
    });
    // emailVerified defaults to false.
    let rows = (await client.raw(
      `SELECT email_verified FROM users WHERE id = $1`,
      [userId],
    )) as Array<{ email_verified: boolean }>;
    expect(rows[0]!.email_verified).toBe(false);

    // The signup email landed in the sink; pull the verify token out of it.
    const msg = [...sent].reverse().find((m) => m.to === "verify@example.com");
    expect(msg).toBeTruthy();
    const token = /token to verify your email: ([0-9a-f]+)/.exec(msg!.text)?.[1];
    expect(token).toBeTruthy();

    // Token stored hashed, not plaintext.
    const stored = (await client.raw(
      `SELECT token_hash FROM email_verify_tokens WHERE user_id = $1`,
      [userId],
    )) as Array<{ token_hash: string }>;
    expect(stored[0]!.token_hash).not.toBe(token);

    await auth.verifyEmail(token!);
    rows = (await client.raw(
      `SELECT email_verified FROM users WHERE id = $1`,
      [userId],
    )) as Array<{ email_verified: boolean }>;
    expect(rows[0]!.email_verified).toBe(true);
  });

  it("rejects a bad verify token", async () => {
    await expect(auth.verifyEmail("not-a-real-token")).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("rejects an expired verify token", async () => {
    const { userId } = await auth.signup({
      email: "vexpire@example.com",
      password: "password123",
    });
    const msg = [...sent].reverse().find((m) => m.to === "vexpire@example.com");
    const token = /token to verify your email: ([0-9a-f]+)/.exec(msg!.text)?.[1];
    await client.raw(
      `UPDATE email_verify_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
      [userId],
    );
    await expect(auth.verifyEmail(token!)).rejects.toThrow(/invalid or expired/);
  });
});
