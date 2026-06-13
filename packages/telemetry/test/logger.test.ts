import { expect, test } from "vitest";
import type { Sink, TelemetryEvent } from "../src/event.ts";
import { createLogger } from "../src/logger.ts";

test("createLogger appends log events with base context and per-call fields", () => {
  const events: TelemetryEvent[] = [];
  const fakeSink: Sink = {
    append(e: TelemetryEvent): void {
      events.push(e);
    },
    all(): TelemetryEvent[] {
      return events;
    },
  };

  const logger = createLogger(fakeSink, { deployVersion: "v1" });
  logger.info("hello", { route: "/x" });
  logger.error("boom");

  expect(events).toHaveLength(2);

  const first = events[0]!;
  expect(first.kind).toBe("log");
  expect(first.level).toBe("info");
  expect(first.message).toBe("hello");
  expect(first.route).toBe("/x");
  expect(first.deployVersion).toBe("v1");
  expect(typeof first.ts).toBe("number");
  expect(first.ts).toBeGreaterThan(0);

  const second = events[1]!;
  expect(second.kind).toBe("log");
  expect(second.level).toBe("error");
  expect(second.message).toBe("boom");
  expect(second.deployVersion).toBe("v1");
  expect(typeof second.ts).toBe("number");
  expect(second.ts).toBeGreaterThan(0);
});
