import { describe, it, expect, afterEach } from "vitest";
import { resolveAuthSecret } from "../src/secret.ts";

const origSecret = process.env.PODKIT_AUTH_SECRET;
const origNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (origSecret === undefined) delete process.env.PODKIT_AUTH_SECRET;
  else process.env.PODKIT_AUTH_SECRET = origSecret;
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
});

describe("resolveAuthSecret", () => {
  it("returns the env secret when set", () => {
    process.env.PODKIT_AUTH_SECRET = "real-secret";
    expect(resolveAuthSecret()).toBe("real-secret");
  });

  it("throws in production when the secret is unset", () => {
    delete process.env.PODKIT_AUTH_SECRET;
    process.env.NODE_ENV = "production";
    expect(() => resolveAuthSecret()).toThrow(/required in production/);
  });

  it("falls back to a dev default outside production", () => {
    delete process.env.PODKIT_AUTH_SECRET;
    process.env.NODE_ENV = "development";
    expect(resolveAuthSecret()).toBe("podkit-dev-secret");
  });
});
