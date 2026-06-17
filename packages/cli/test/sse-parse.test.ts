import { describe, expect, it } from "vitest";
import { parseSseChunk } from "../src/commands/cloud.ts";

describe("parseSseChunk", () => {
  it("parses a complete SSE event from a single chunk", () => {
    const chunk = 'data: {"line":"hello world"}\n\n';
    const { buf, values } = parseSseChunk("", chunk);
    expect(buf).toBe("");
    expect(values).toEqual([{ line: "hello world" }]);
  });

  it("handles multiple events in one chunk", () => {
    const chunk =
      'data: {"line":"first"}\n\ndata: {"line":"second"}\n\n';
    const { buf, values } = parseSseChunk("", chunk);
    expect(buf).toBe("");
    expect(values).toEqual([{ line: "first" }, { line: "second" }]);
  });

  it("buffers an incomplete event across calls", () => {
    const partial = 'data: {"line":"parti';
    const { buf: buf1, values: v1 } = parseSseChunk("", partial);
    expect(v1).toEqual([]);
    expect(buf1).toBe(partial);

    const rest = 'al"}\n\n';
    const { buf: buf2, values: v2 } = parseSseChunk(buf1, rest);
    expect(buf2).toBe("");
    expect(v2).toEqual([{ line: "partial" }]);
  });

  it("ignores SSE comment lines", () => {
    const chunk = ": connected\n\ndata: {\"line\":\"msg\"}\n\n";
    const { values } = parseSseChunk("", chunk);
    expect(values).toEqual([{ line: "msg" }]);
  });

  it("skips malformed data lines", () => {
    const chunk = "data: not-json\n\ndata: {\"line\":\"ok\"}\n\n";
    const { values } = parseSseChunk("", chunk);
    expect(values).toEqual([{ line: "ok" }]);
  });

  it("handles an event split across exactly the double-newline boundary", () => {
    const part1 = 'data: {"line":"split"}\n';
    const part2 = "\n";
    const { buf: buf1, values: v1 } = parseSseChunk("", part1);
    expect(v1).toEqual([]);

    const { buf: buf2, values: v2 } = parseSseChunk(buf1, part2);
    expect(buf2).toBe("");
    expect(v2).toEqual([{ line: "split" }]);
  });

  it("returns empty values for a pure keep-alive comment with no data", () => {
    const { values } = parseSseChunk("", ": keep-alive\n\n");
    expect(values).toEqual([]);
  });
});
