import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

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
