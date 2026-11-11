import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../src/index.ts";

const code = (s: string | Uint8Array, l = {}) => {
  const r = parseStrictJson(s, l);
  return r.ok ? "OK" : r.code;
};

describe("parseStrictJson", () => {
  it("parses ordinary documents identically to JSON.parse", () => {
    const doc = { a: [1, 2.5, -3e2, 'x\né"\\'], b: { c: null, d: true }, e: "" };
    const r = parseStrictJson(JSON.stringify(doc));
    expect(r.ok && r.value).toEqual(doc);
  });
  it("rejects duplicate keys, even when escaped differently", () => {
    expect(code('{"a":1,"a":2}')).toBe("DUPLICATE_KEY");
    expect(code('{"a":1,"\\u0061":2}')).toBe("DUPLICATE_KEY");
    expect(code('{"a":{"a":1},"b":{"a":2}}')).toBe("OK");
  });
  it("rejects prototype pollution keys", () => {
    expect(code('{"__proto__":{"admin":true}}')).toBe("FORBIDDEN_KEY");
    expect(code('{"constructor":{"prototype":{"x":1}}}')).toBe("FORBIDDEN_KEY");
    expect(code('{"constructor":1,"prototype":2}')).toBe("OK");
  });
  it("bounds depth without recursion", () => {
    expect(code("[".repeat(10_000) + "]".repeat(10_000))).toBe("TOO_DEEP");
    expect(code("[".repeat(64) + "]".repeat(64))).toBe("OK");
    expect(code("[".repeat(65) + "]".repeat(65))).toBe("TOO_DEEP");
  });
  it("bounds size, utf-8, numbers, nodes and array length", () => {
    expect(code("1".repeat(200), { maxBytes: 100 })).toBe("TOO_LARGE");
    expect(code(new Uint8Array([0x22, 0xc3, 0x28, 0x22]))).toBe("INVALID_UTF8");
    expect(code("1e999")).toBe("NUMBER_OUT_OF_RANGE");
    expect(code("9".repeat(400))).toBe("NUMBER_OUT_OF_RANGE");
    expect(code("[1,2,3,4]", { maxNodes: 3 })).toBe("TOO_MANY_NODES");
    expect(code("[1,2,3,4]", { maxArrayItems: 3 })).toBe("TOO_MANY_ITEMS");
    expect(code("")).toBe("EMPTY");
  });
  it("rejects malformed syntax", () => {
    for (const s of [
      "{",
      "[1,]",
      '{"a":1,}',
      "{'a':1}",
      "[1 2]",
      '{"a" 1}',
      "nul",
      "01",
      '"\\x"',
      "1 2",
      "﻿{}",
    ])
      expect(code(s), s).toBe("INVALID_JSON");
  });
});
