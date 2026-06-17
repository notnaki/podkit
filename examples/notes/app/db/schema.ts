import { pgTable, uuid, text, timestamp } from "@podkit/db";

// Drizzle schema — same shape db.ts creates on first run. Routes import `notes`
// from here and use the typed drizzle query API (no hand-written SQL).
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at"),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at"),
});
