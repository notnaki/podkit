import { describe, it, expect } from "vitest";
import { buildRequestEvent } from "../src/request/log.ts";

describe("buildRequestEvent", () => {
  it("builds a log TelemetryEvent from a request entry", () => {
    const event = buildRequestEvent({
      method: "GET",
      path: "/x",
      status: 200,
      durationMs: 5,
      requestId: "r1",
      identity: "u1",
    });

    expect(event.kind).toBe("log");
    expect(event.level).toBe("info");
    expect(event.route).toBe("/x");
    expect(event.requestId).toBe("r1");
    expect(event.identity).toBe("u1");
    expect(event.props).toEqual({ method: "GET", status: 200, durationMs: 5 });
    expect(event.message).toContain("GET");
    expect(event.message).toContain("/x");
    expect(event.message).toContain("200");
    expect(typeof event.ts).toBe("number");
    expect(event.ts).toBeGreaterThan(0);
  });
});
