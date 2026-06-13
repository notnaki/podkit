import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateMigration } from "../src/migrations/generate.ts";

const tempDir = mkdtempSync(join(tmpdir(), "podkit-gen-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("generateMigration", () => {
  it(
    "generates a SQL migration file for a postgres schema",
    async () => {
      // Write a self-contained fixture schema that imports directly from drizzle-orm/pg-core.
      const schemaPath = join(tempDir, "fixture-schema.ts");
      writeFileSync(
        schemaPath,
        `import { pgTable, uuid, text } from "drizzle-orm/pg-core";\nexport const posts = pgTable("posts", { id: uuid("id").primaryKey().defaultRandom(), title: text("title") });\n`,
        "utf-8"
      );

      const outDir = join(tempDir, "migrations");
      mkdirSync(outDir, { recursive: true });

      const result = await generateMigration({ schemaPath, outDir });

      // Returned path must be absolute and the file must exist.
      expect(result.file).toMatch(/\.sql$/);
      expect(existsSync(result.file)).toBe(true);

      const contents = readFileSync(result.file, "utf-8");

      // drizzle-kit emits CREATE TABLE with the table name "posts".
      expect(contents.toLowerCase()).toContain("create table");
      expect(contents.toLowerCase()).toContain("posts");
    },
    60000
  );

  it(
    "respects the --name flag and includes it in the generated filename",
    async () => {
      // Use a fresh outDir so the snapshot starts clean.
      const outDir2 = join(tempDir, "migrations-named");
      mkdirSync(outDir2, { recursive: true });

      const schemaPath = join(tempDir, "fixture-schema.ts");

      const result = await generateMigration({
        schemaPath,
        outDir: outDir2,
        name: "init_posts",
      });

      expect(result.file).toMatch(/init_posts\.sql$/);
      expect(existsSync(result.file)).toBe(true);
    },
    60000
  );
});
