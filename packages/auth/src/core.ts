import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "@podkit/db";
import { users } from "./schema.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import {
  signToken,
  verifyToken,
  issueAgentToken as issueAgentTokenFromToken,
} from "./token.ts";

export interface Identity {
  userId: string;
  isAgent: boolean;
  scopes?: string[];
}

export function createAuth(opts: {
  db: DbClient["db"];
  secret: string;
}) {
  const { db, secret } = opts;

  async function signup({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ userId: string }> {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));

    if (existing.length > 0) {
      throw new Error("email already registered");
    }

    const userId = randomUUID();
    const passwordHash = hashPassword(password);

    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
    });

    return { userId };
  }

  async function login({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<{ token: string }> {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, email));

    const user = rows[0];

    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new Error("invalid credentials");
    }

    const token = signToken({ userId: user.id, kind: "session" }, secret);
    return { token };
  }

  function verifySession(token: string): Identity | null {
    const payload = verifyToken(token, secret);
    if (!payload) return null;

    const userId = payload["userId"];
    if (typeof userId !== "string") return null;

    const kind = payload["kind"];
    const isAgent = kind === "agent";
    const rawScopes = payload["scopes"];
    const scopes = Array.isArray(rawScopes)
      ? (rawScopes as string[])
      : undefined;

    return { userId, isAgent, scopes };
  }

  function issueAgentToken({
    userId,
    scopes,
  }: {
    userId: string;
    scopes: string[];
  }): string {
    return issueAgentTokenFromToken({ userId, scopes }, secret);
  }

  return { signup, login, verifySession, issueAgentToken };
}
