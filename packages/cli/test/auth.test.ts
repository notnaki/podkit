import { describe, it, expect, beforeAll } from "vitest";
import { authCommand } from "../src/commands/auth.ts";

beforeAll(() => {
  // Use the default dev secret so token and whoami calls use the same key
  process.env.PODKIT_AUTH_SECRET = "podkit-dev-secret";
});

describe("authCommand — token (no DB)", () => {
  it("issues a token for --user with multiple --scope flags", async () => {
    const result = await authCommand([
      "token",
      "--user",
      "u1",
      "--scope",
      "read",
      "--scope",
      "write",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data).toBe("object");
      const data = result.data as { token: string };
      expect(typeof data.token).toBe("string");
      expect(data.token.length).toBeGreaterThan(0);
    }
  });

  it("round-trips via whoami — userId, isAgent, scopes", async () => {
    const tokenResult = await authCommand([
      "token",
      "--user",
      "u1",
      "--scope",
      "read",
      "--scope",
      "write",
    ]);
    expect(tokenResult.ok).toBe(true);
    if (!tokenResult.ok) return;

    const { token } = tokenResult.data as { token: string };

    const whoamiResult = await authCommand(["whoami", "--token", token]);
    expect(whoamiResult.ok).toBe(true);
    if (whoamiResult.ok) {
      const identity = whoamiResult.data as {
        userId: string;
        isAgent: boolean;
        scopes: string[];
      };
      expect(identity.userId).toBe("u1");
      expect(identity.isAgent).toBe(true);
      expect(identity.scopes).toEqual(["read", "write"]);
    }
  });

  it("returns E_UNAUTHORIZED for a garbage token", async () => {
    const result = await authCommand(["whoami", "--token", "garbage"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_UNAUTHORIZED");
    }
  });

  it("returns E_BAD_ARGS when --user is missing from token subcommand", async () => {
    const result = await authCommand(["token"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });

  it("returns E_BAD_ARGS for an unknown subcommand", async () => {
    const result = await authCommand(["bogus"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_BAD_ARGS");
    }
  });
});
