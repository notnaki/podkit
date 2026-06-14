import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").unique().notNull(),
  owner: text("owner"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id"),
  version: text("version"),
  containerId: text("container_id"),
  hostPort: integer("host_port"),
  status: text("status"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const projectEnv = pgTable(
  "project_env",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    sensitive: boolean("sensitive").notNull().default(false),
  },
  (t) => [unique().on(t.projectId, t.key)],
);

export const projectDomains = pgTable("project_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  domain: text("domain").unique().notNull(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const cliSessions = pgTable("cli_auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceCode: text("device_code").unique().notNull(),
  userCode: text("user_code").notNull(),
  status: text("status").notNull(),
  accountId: uuid("account_id"),
  token: text("token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow(),
});
