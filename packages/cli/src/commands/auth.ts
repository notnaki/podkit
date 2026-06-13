import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createDbClient } from "@podkit/db";
import { createAuth, issueAgentToken, verifyToken } from "@podkit/auth";
import { ok, fail, type Envelope } from "../envelope.ts";
import { PodkitError } from "../errors.ts";

const secret = process.env.PODKIT_AUTH_SECRET ?? "podkit-dev-secret";

export async function authCommand(args: string[]): Promise<Envelope<unknown>> {
  const [subcommand, ...rest] = args;

  try {
    if (subcommand === "token") {
      // Parse --user <id> and zero-or-more --scope <s> flags
      const userIdx = rest.indexOf("--user");
      if (userIdx === -1 || !rest[userIdx + 1]) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--user is required",
            "podkit auth token --user <id> [--scope <s>]",
          ),
        );
      }
      const userId = rest[userIdx + 1];

      const scopes: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--scope" && rest[i + 1]) {
          scopes.push(rest[i + 1]);
          i++;
        }
      }

      const token = issueAgentToken({ userId, scopes }, secret);
      return ok({ token });
    }

    if (subcommand === "whoami") {
      const tokenIdx = rest.indexOf("--token");
      if (tokenIdx === -1 || !rest[tokenIdx + 1]) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--token is required",
            "podkit auth whoami --token <t>",
          ),
        );
      }
      const token = rest[tokenIdx + 1];

      const payload = verifyToken(token, secret);
      if (!payload) {
        return fail(
          new PodkitError(
            "E_UNAUTHORIZED",
            "invalid or expired token",
            "check the token and PODKIT_AUTH_SECRET",
          ),
        );
      }

      const userId = payload["userId"];
      if (typeof userId !== "string") {
        return fail(
          new PodkitError(
            "E_UNAUTHORIZED",
            "invalid or expired token",
            "check the token and PODKIT_AUTH_SECRET",
          ),
        );
      }

      const identity = {
        userId,
        isAgent: payload["kind"] === "agent",
        scopes: Array.isArray(payload["scopes"])
          ? (payload["scopes"] as string[])
          : undefined,
      };
      return ok(identity);
    }

    if (subcommand === "signup") {
      const emailIdx = rest.indexOf("--email");
      const passwordIdx = rest.indexOf("--password");

      if (emailIdx === -1 || !rest[emailIdx + 1]) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--email is required",
            "podkit auth signup --email <e> --password <p>",
          ),
        );
      }
      if (passwordIdx === -1 || !rest[passwordIdx + 1]) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--password is required",
            "podkit auth signup --email <e> --password <p>",
          ),
        );
      }

      const email = rest[emailIdx + 1];
      const password = rest[passwordIdx + 1];

      const dataDir = join(process.cwd(), ".podkit/pgdata");
      mkdirSync(dataDir, { recursive: true });

      const client = createDbClient({ dataDir });
      try {
        await client.raw(
          "CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text, created_at timestamptz)",
        );
        const auth = createAuth({ db: client.db, secret });
        const { userId } = await auth.signup({ email, password });
        return ok({ userId });
      } finally {
        await client.close();
      }
    }

    if (subcommand === "login") {
      const emailIdx = rest.indexOf("--email");
      const passwordIdx = rest.indexOf("--password");

      if (emailIdx === -1 || !rest[emailIdx + 1]) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--email is required",
            "podkit auth login --email <e> --password <p>",
          ),
        );
      }
      if (passwordIdx === -1 || !rest[passwordIdx + 1]) {
        return fail(
          new PodkitError(
            "E_BAD_ARGS",
            "--password is required",
            "podkit auth login --email <e> --password <p>",
          ),
        );
      }

      const email = rest[emailIdx + 1];
      const password = rest[passwordIdx + 1];

      const dataDir = join(process.cwd(), ".podkit/pgdata");
      mkdirSync(dataDir, { recursive: true });

      const client = createDbClient({ dataDir });
      try {
        await client.raw(
          "CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text, created_at timestamptz)",
        );
        const auth = createAuth({ db: client.db, secret });
        const { token } = await auth.login({ email, password });
        return ok({ token });
      } finally {
        await client.close();
      }
    }

    return fail(
      new PodkitError(
        "E_BAD_ARGS",
        subcommand
          ? `Unknown auth subcommand: ${subcommand}`
          : "No auth subcommand given",
        "Available auth subcommands: signup, login, token, whoami",
      ),
    );
  } catch (err) {
    return fail(err);
  }
}
