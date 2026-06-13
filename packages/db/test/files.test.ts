import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  migrationFilename,
  listMigrations,
  readMigration,
} from "../src/migrations/files.ts";

const dir = mkdtempSync(join(tmpdir(), "podkit-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrationFilename", () => {
  it("formats a 13-digit timestamp and sanitized name", () => {
    expect(migrationFilename(1700000000000, "Create Posts!")).toBe(
      "1700000000000_create_posts.sql"
    );
  });

  it("zero-pads timestamps shorter than 13 digits", () => {
    expect(migrationFilename(42, "add idx")).toBe(
      "0000000000042_add_idx.sql"
    );
  });
});

describe("listMigrations", () => {
  it("returns sorted entries for .sql files, ignoring non-sql", () => {
    writeFileSync(join(dir, "0000000000002_b.sql"), "-- b");
    writeFileSync(join(dir, "0000000000001_a.sql"), "-- a");
    writeFileSync(join(dir, "notes.txt"), "ignore me");

    const results = listMigrations(dir);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: "0000000000001",
      name: "a",
      path: join(dir, "0000000000001_a.sql"),
    });
    expect(results[1]).toMatchObject({
      id: "0000000000002",
      name: "b",
      path: join(dir, "0000000000002_b.sql"),
    });
  });

  it("returns [] when the directory does not exist", () => {
    expect(listMigrations("/nonexistent/path/that/does/not/exist")).toEqual([]);
  });
});

describe("readMigration", () => {
  it("returns the utf-8 content of the file", () => {
    const filePath = join(dir, "0000000000003_c.sql");
    const sql = "CREATE TABLE foo (id INT);";
    writeFileSync(filePath, sql, "utf-8");

    expect(readMigration(filePath)).toBe(sql);
  });
});
