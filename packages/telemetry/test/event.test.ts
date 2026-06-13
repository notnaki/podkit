import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSink, query } from "../src/event.ts";
import type { TelemetryEvent } from "../src/event.ts";

const dir = mkdtempSync(join(tmpdir(), "podkit-telemetry-"));
const file = join(dir, "events.log");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("telemetry event sink", () => {
  it("appends and reads events in order", () => {
    const sink = createSink({ file });
    sink.append({ ts: 1, kind: "log", level: "info", message: "a", route: "/x" });
    sink.append({ ts: 2, kind: "log", level: "error", message: "b", route: "/y" });
    sink.append({ ts: 3, kind: "event", name: "signup" });

    const all = sink.all();
    expect(all.length).toBe(3);
    expect(all.map((e: TelemetryEvent) => e.ts)).toEqual([1, 2, 3]);
  });

  it("returns [] when file is missing", () => {
    const missing = createSink({ file: join(dir, "nope.log") });
    expect(missing.all()).toEqual([]);
  });

  it("filters by level", () => {
    const all = createSink({ file }).all();
    const errors = query(all, { level: "error" });
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe("b");
  });

  it("filters by kind", () => {
    const all = createSink({ file }).all();
    const events = query(all, { kind: "event" });
    expect(events.length).toBe(1);
    expect(events[0]?.name).toBe("signup");
  });

  it("filters by since", () => {
    const all = createSink({ file }).all();
    expect(query(all, { since: 2 }).length).toBe(2);
  });

  it("filters by route", () => {
    const all = createSink({ file }).all();
    const r = query(all, { route: "/x" });
    expect(r.length).toBe(1);
    expect(r[0]?.message).toBe("a");
  });
});
