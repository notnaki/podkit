import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { users, sessions, orgs, memberships } from "../src/schema.ts";

describe("auth DB schema", () => {
  describe("users table", () => {
    it("has columns: id, email, passwordHash, createdAt", () => {
      const cols = getTableColumns(users);
      expect(Object.keys(cols)).toEqual(
        expect.arrayContaining(["id", "email", "passwordHash", "createdAt"])
      );
    });

    it("id column is a primary key", () => {
      expect(getTableColumns(users).id.primary).toBe(true);
    });

    it("email column has name 'email'", () => {
      expect(getTableColumns(users).email.name).toBe("email");
    });
  });

  describe("sessions table", () => {
    it("has columns: id, userId, expiresAt", () => {
      expect(Object.keys(getTableColumns(sessions))).toEqual(
        expect.arrayContaining(["id", "userId", "expiresAt"])
      );
    });
  });

  describe("orgs table", () => {
    it("has columns: id, name", () => {
      expect(Object.keys(getTableColumns(orgs))).toEqual(
        expect.arrayContaining(["id", "name"])
      );
    });
  });

  describe("memberships table", () => {
    it("has columns: id, userId, orgId, role", () => {
      expect(Object.keys(getTableColumns(memberships))).toEqual(
        expect.arrayContaining(["id", "userId", "orgId", "role"])
      );
    });
  });
});
