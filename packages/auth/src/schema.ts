import { pgTable, uuid, text, timestamp, boolean, uuidPk } from "@podkit/db";

export const users = pgTable("users", {
  id: uuidPk(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  // Email-verification flag. Default false; flipped true by verifyEmail().
  // ponytail: login is NOT gated on this (see core.ts) — the flag is exposed so
  //   callers can surface it; the upgrade is to reject login when !emailVerified.
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at"),
});

// timestamptz everywhere below: these are absolute instants compared against
// Date.now(), so the column must be timezone-aware or drizzle reinterprets the
// stored UTC value in the server's local zone and shifts the instant.
export const sessions = pgTable("sessions", {
  id: uuidPk(),
  userId: uuid("user_id"),
  // When the session stops being valid. resolveSession() rejects sessions past
  // this instant. NULL is tolerated (legacy rows) and treated as non-expiring.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Table-backed revocation: a non-null timestamp means the session was killed
  // (logout / password reset) and must be rejected even if unexpired.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

// Single-use, expiring password-reset tokens. Only the SHA-256 hash of the
// token is stored (never the plaintext); the plaintext is emailed to the user.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuidPk(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Set when the token is consumed; a non-null value makes it single-use.
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

// Single-use, expiring email-verification tokens. Same hashed-at-rest scheme as
// password-reset tokens.
export const emailVerifyTokens = pgTable("email_verify_tokens", {
  id: uuidPk(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

export const orgs = pgTable("orgs", {
  id: uuidPk(),
  name: text("name"),
});

export const memberships = pgTable("memberships", {
  id: uuidPk(),
  userId: uuid("user_id"),
  orgId: uuid("org_id"),
  role: text("role"),
});
