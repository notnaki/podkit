import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  assertChannel,
  createRealtime,
  notifyTriggerSql,
} from "../src/realtime.ts";
import type { Realtime } from "../src/realtime.ts";

const open: Realtime[] = [];
function realtime(): Realtime {
  // Force the PGlite path regardless of a stray DATABASE_URL in the env.
  const r = createRealtime({ pglite: new PGlite() });
  open.push(r);
  return r;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe("assertChannel — injection guard", () => {
  it("accepts plain identifiers", () => {
    for (const ok of ["jobs", "user_events", "_x", "ch$1", "A1"]) {
      expect(assertChannel(ok)).toBe(ok);
    }
  });

  it("rejects anything that isn't a bare identifier", () => {
    const bad = [
      "",
      "1leading",
      "has space",
      "drop;table",
      'a"; NOTIFY x; --',
      "schema.channel",
      '"quoted"',
      "a".repeat(64), // over NAMEDATALEN-1
    ];
    for (const b of bad) {
      expect(() => assertChannel(b)).toThrow(/invalid realtime channel/);
    }
  });
});

describe("notifyTriggerSql", () => {
  it("emits a row-to-json NOTIFY trigger and validates identifiers", () => {
    const sql = notifyTriggerSql("notes", "notes_changed");
    expect(sql).toContain("pg_notify('notes_changed'");
    expect(sql).toContain("row_to_json(COALESCE(NEW, OLD))");
    expect(sql).toContain('ON "notes"');
    // injection via table/channel name is rejected
    expect(() => notifyTriggerSql("notes", "x; DROP TABLE notes")).toThrow();
    expect(() => notifyTriggerSql("a; DROP", "ok")).toThrow();
  });
});

describe("createRealtime — pub/sub round trip (PGlite)", () => {
  it("delivers a NOTIFY payload to a subscriber, then stops after unsubscribe", async () => {
    const r = realtime();
    const received: string[] = [];
    const unsub = await r.subscribe("orders", (p) => received.push(p));

    await r.notify("orders", "first");
    // PGlite delivers notifications on the microtask/IO turn; give it a tick.
    await new Promise((res) => setTimeout(res, 50));
    expect(received).toEqual(["first"]);

    await unsub();
    await r.notify("orders", "after-unsub");
    await new Promise((res) => setTimeout(res, 50));
    expect(received).toEqual(["first"]); // no further delivery

    await expect(unsub()).resolves.toBeUndefined(); // idempotent
  });

  it("a throwing handler never escapes the notification callback", async () => {
    const r = realtime();
    await r.subscribe("boom", () => {
      throw new Error("handler blew up");
    });
    // Should not reject / crash despite the handler throwing.
    await expect(r.notify("boom", "x")).resolves.toBeUndefined();
    await new Promise((res) => setTimeout(res, 50));
  });
});
