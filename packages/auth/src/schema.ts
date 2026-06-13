import { pgTable, uuid, text, timestamp, uuidPk } from "@podkit/db";

export const users = pgTable("users", {
  id: uuidPk(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at"),
});

export const sessions = pgTable("sessions", {
  id: uuidPk(),
  userId: uuid("user_id"),
  expiresAt: timestamp("expires_at"),
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
