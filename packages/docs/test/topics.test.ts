import { describe, it, expect } from "vitest";
import { listTopics, getDoc } from "../src/topics.ts";
import type { Doc } from "../src/topics.ts";

describe("docs registry", () => {
  it("listTopics returns sorted keys including the core topics", () => {
    const topics = listTopics();
    expect(topics).toEqual(arraySorted(topics));
    expect(topics).toEqual(
      expect.arrayContaining(["routing", "db", "auth", "deploy", "cli"])
    );
  });

  it("getDoc('routing') returns a Doc whose content mentions routing", () => {
    const doc = getDoc("routing");
    expect(doc).not.toBeNull();
    const real = doc as Doc;
    expect(real.topic).toBe("routing");
    expect(real.title.length).toBeGreaterThan(0);
    expect(real.content.toLowerCase()).toContain("route");
  });

  it("getDoc('auth') content mentions token", () => {
    const doc = getDoc("auth");
    expect(doc).not.toBeNull();
    expect((doc as Doc).content.toLowerCase()).toContain("token");
  });

  it("getDoc returns null for an unknown topic", () => {
    expect(getDoc("nope")).toBeNull();
  });

  it("every listed topic resolves to a Doc with matching topic key", () => {
    for (const topic of listTopics()) {
      const doc = getDoc(topic);
      expect(doc).not.toBeNull();
      expect((doc as Doc).topic).toBe(topic);
    }
  });
});

function arraySorted(input: readonly string[]): string[] {
  return [...input].sort();
}
