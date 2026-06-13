import { describe, it, expect, afterAll } from "vitest";
import { createDbClient } from "@podkit/db";
import { createAuth } from "../src/core.ts";

const client = createDbClient();

afterAll(async () => {
  await client.close();
});

await client.raw(
  "CREATE TABLE users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text, created_at timestamptz)"
);

const auth = createAuth({ db: client.db, secret: "test-secret" });

describe("createAuth", () => {
  it("signup then login returns a valid session token", async () => {
    const { userId } = await auth.signup({
      email: "alice@example.com",
      password: "hunter2",
    });

    const { token } = await auth.login({
      email: "alice@example.com",
      password: "hunter2",
    });

    expect(typeof token).toBe("string");

    const identity = auth.verifySession(token);
    expect(identity).toEqual({ userId, isAgent: false, scopes: undefined });
  });

  it("login with wrong password rejects", async () => {
    await auth.signup({
      email: "bob@example.com",
      password: "correct-password",
    });

    await expect(
      auth.login({ email: "bob@example.com", password: "wrong-password" })
    ).rejects.toThrow("invalid credentials");
  });

  it("duplicate signup rejects", async () => {
    await auth.signup({
      email: "carol@example.com",
      password: "password1",
    });

    await expect(
      auth.signup({ email: "carol@example.com", password: "password2" })
    ).rejects.toThrow("email already registered");
  });

  it("verifySession on an agent token returns isAgent: true", () => {
    const token = auth.issueAgentToken({ userId: "u1", scopes: ["read"] });
    const identity = auth.verifySession(token);
    expect(identity).toEqual({ userId: "u1", isAgent: true, scopes: ["read"] });
  });

  it("verifySession on garbage returns null", () => {
    expect(auth.verifySession("garbage")).toBeNull();
  });
});
