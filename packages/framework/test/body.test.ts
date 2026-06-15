import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { parseFormUrlEncoded, readBody, BodyTooLargeError } from "../src/request/body.ts";

function fakeReq(chunks: string[]) {
  const s = new PassThrough();
  for (const c of chunks) s.write(c);
  s.end();
  return s as unknown as import("node:http").IncomingMessage;
}

describe("parseFormUrlEncoded", () => {
  it("parses simple key=value pairs", () => {
    expect(parseFormUrlEncoded("a=1&b=2")).toEqual({ a: "1", b: "2" });
  });

  it("decodes '+' to spaces and percent-escapes", () => {
    expect(parseFormUrlEncoded("message=hello+world%21")).toEqual({
      message: "hello world!",
    });
  });

  it("accepts a Buffer body", () => {
    expect(parseFormUrlEncoded(Buffer.from("x=y"))).toEqual({ x: "y" });
  });

  it("returns an empty object for an empty body", () => {
    expect(parseFormUrlEncoded("")).toEqual({});
  });

  it("keeps the last value when a key repeats", () => {
    expect(parseFormUrlEncoded("k=1&k=2")).toEqual({ k: "2" });
  });
});

describe("readBody", () => {
  it("reads the full body up to the limit", async () => {
    const buf = await readBody(fakeReq(["a=1", "&b=2"]), 1024);
    expect(buf.toString("utf8")).toBe("a=1&b=2");
  });

  it("rejects with BodyTooLargeError when the body exceeds the limit", async () => {
    const big = "x".repeat(2048);
    await expect(readBody(fakeReq([big]), 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});
