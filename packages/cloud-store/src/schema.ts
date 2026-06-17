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
  containerPort: integer("container_port"),
  kind: text("kind").default("deploy"),
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
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  tokenHash: text("token_hash").unique().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const emailVerifyTokens = pgTable("email_verify_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  tokenHash: text("token_hash").unique().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
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

// ponytail: project-level roles as plain text; upgrade to full org/RBAC if teams grow.
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    accountId: text("account_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique().on(t.projectId, t.accountId)],
);

export const projectInvites = pgTable("project_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  token: text("token").unique().notNull(),
  accepted: boolean("accepted").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ponytail: bytea storage in Postgres; fine for small assets (< a few MB per blob).
// Upgrade to S3-compatible object store (presigned URLs) if large files or high
// throughput matter; the store interface stays the same, only the backing changes.
// NOTE: the `data` column is declared as text() here (drizzle has no bytea type);
// the actual DDL in migrate() creates it as bytea. This definition is for
// documentation only — store methods use raw parameterized SQL for the data column.
export const blobs = pgTable(
  "blobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    key: text("key").notNull(),
    contentType: text("content_type").notNull(),
    data: text("data").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique().on(t.projectId, t.key)],
);

export const crons = pgTable(
  "crons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    schedule: text("schedule").notNull(),
    path: text("path").notNull(),
    method: text("method").notNull().default("GET"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique().on(t.projectId, t.name)],
);
