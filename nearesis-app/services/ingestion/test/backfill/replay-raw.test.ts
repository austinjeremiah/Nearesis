import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/hash.ts";
import { classifyRawObject, knownHashes, listArchive, priceWindowOf } from "../../src/backfill/replay-raw.ts";
import { WINDOW_FROM } from "../../src/backfill/plan.ts";
import type { ChunkDone } from "../../src/backfill/state.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const chunk = { id: "transactions:2026-11-01", rawObjectHash: "a".repeat(64) } as ChunkDone;
const known = knownHashes(
  { [chunk.id]: chunk },
  { "account:2026-11-01": { id: "account:2026-11-01", rawObjectHash: "b".repeat(64) } as never },
);

describe("replay classifier", () => {
  it("trusts the progress files first", () => {
    expect(classifyRawObject("a".repeat(64), enc("[]"), known)).toBe("bq-chunk");
    expect(classifyRawObject("b".repeat(64), enc("[]"), known)).toBe("account");
  });
  it("classifies by content otherwise", () => {
    expect(classifyRawObject("c", enc('[{"originAsset":"x"}]'), known)).toBe("explorer");
    expect(classifyRawObject("c", enc('[{"kind":"day"}]'), known)).toBe("account");
    expect(classifyRawObject("c", enc('{"prices":[[1,2]]}'), known)).toBe("price");
    expect(classifyRawObject("c", enc('{"other":1}'), known)).toBe("unknown");
    expect(classifyRawObject("c", enc("garbage"), known)).toBe("unknown");
  });
  it("matches a price object to its request window by first sample", () => {
    const ts = Date.parse(`${WINDOW_FROM}T00:00:00Z`);
    expect(priceWindowOf(enc(JSON.stringify({ prices: [[ts, 1]] })))?.from).toBe(WINDOW_FROM);
    expect(priceWindowOf(enc('{"prices":[]}'))).toBeNull();
  });
  it("lists the content-addressed archive oldest first and ignores stray files", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-"));
    try {
      const h = sha256Hex(enc("x"));
      mkdirSync(join(root, h.slice(0, 2)));
      writeFileSync(join(root, h.slice(0, 2), h), "x");
      writeFileSync(join(root, h.slice(0, 2), "tmp.partial"), "x");
      expect(listArchive(root).map((f) => f.hash)).toEqual([h]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
