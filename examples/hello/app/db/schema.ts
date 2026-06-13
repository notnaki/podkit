import { pgTable, uuidPk, text, timestamp } from "@podkit/db";

export const posts = pgTable("posts", {
  id: uuidPk(),
  title: text("title"),
  body: text("body"),
  createdAt: timestamp("created_at"),
});
