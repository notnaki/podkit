import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { pgTable, text, integer, boolean, uuidPk } from "../src/schema.ts";

const posts = pgTable("posts", {
  id: uuidPk(),
  title: text("title"),
  views: integer("views"),
  published: boolean("published"),
});

describe("schema re-exports and uuidPk helper", () => {
  it("table has all expected columns", () => {
    const keys = Object.keys(getTableColumns(posts));
    expect(keys).toContain("id");
    expect(keys).toContain("title");
    expect(keys).toContain("views");
    expect(keys).toContain("published");
  });

  it("id column is a primary key", () => {
    const cols = getTableColumns(posts);
    expect(cols.id.primary).toBe(true);
  });

  it("title column has correct .name", () => {
    const cols = getTableColumns(posts);
    expect(cols.title.name).toBe("title");
  });
});
