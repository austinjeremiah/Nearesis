import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/hash.ts";
import { planReconstruction, type ReconSource } from "../../src/archive/reconstruct.ts";
import type { ChunkDone } from "../../src/backfill/state.ts";

const put = (root: string, body: string, mtime?: Date): string => {
  const hash = sha256Hex(new TextEncoder().encode(body));
  mkdirSync(join(root, hash.slice(0, 2)), { recursive: true });
  const p = join(root, hash.slice(0, 2), hash);
  writeFileSync(p, body);
  if (mtime) utimesSync(p, mtime, mtime);
  return hash;
};

describe("raw archive metadata reconstruction", () => {
  const root = mkdtempSync(join(tmpdir(), "recon-"));
  const mtime = new Date("2026-11-05T10:00:00.000Z");
  const bqBody = '[{"block_date":"2026-11-01"}]';
  const bq = put(root, bqBody, mtime);
  const page = put(root, '[{"originAsset":"a","status":"SUCCESS"}]', mtime);
  const skippedPage = put(root, '[{"originAsset":"b","status":"X"}]', mtime);
  const quote = put(root, '{"quote":{"a":1},"correlationId":"c"}', mtime);
  const tokens = put(root, '[{"assetId":"nep141:x"}]', mtime);
  const price = put(root, '{"prices":[[1,2]]}', mtime);
  const junk = put(root, '{"message":"nope"}', mtime);
  // corrupt: name is a hash but bytes differ
  const bad = "f".repeat(64);
  mkdirSync(join(root, "ff"), { recursive: true });
  writeFileSync(join(root, "ff", bad), "tampered");
  const chunk = {
    id: "transactions:2026-11-01",
    family: "transactions",
    from: "2026-11-01",
    to: "2026-11-10",
    rows: 9,
    jobId: "job-1",
    rawObjectHash: bq,
    completedAtUTC: "2026-11-10T13:25:56.663Z",
  } as ChunkDone;
  const src: ReconSource = { name: "backfill", rawRoot: root, chunks: { [chunk.id]: chunk }, accounts: {} };
  const out = planReconstruction([src], {
    skippedPageHashes: [skippedPage],
    swapLinkage: new Map([
      [
        page,
        { count: 7, minCreatedAt: "2026-11-01T00:00:00.000Z", maxCreatedAt: "2026-11-01T01:00:00.000Z" },
      ],
    ]),
  });
  const by = (h: string) => out.items.find((i) => i.hash === h)!.envelope;

  it("records provenance per field and never invents lost request data", () => {
    const e = by(bq);
    expect(e).toMatchObject({
      reconstructed: true,
      providerId: "near-bigquery",
      payloadObjectHash: bq,
      sizeBytes: bqBody.length,
      fetchedAtUTC: chunk.completedAtUTC,
      linkage: { chunkId: chunk.id, jobId: "job-1", from: "2026-11-01", to: "2026-11-10" },
    });
    expect(e.provenance).toMatchObject({
      payloadObjectHash: "verified_sha256",
      providerId: "progress_file",
      fetchedAtUTC: "progress_file",
      sizeBytes: "observed_file",
    });
    for (const i of out.items) {
      expect(i.envelope).not.toHaveProperty("sourceURL");
      expect(i.envelope).not.toHaveProperty("requestFingerprint");
      expect(i.envelope).not.toHaveProperty("responseStatus");
      expect(i.envelope.notRecoverable).toContain("sourceURL");
    }
  });

  it("uses mtime (marked) when no state recorded the fetch time, and infers providers from payload shape", () => {
    expect(by(page)).toMatchObject({ providerId: "near-explorer", fetchedAtUTC: mtime.toISOString() });
    expect(by(page).provenance.fetchedAtUTC).toBe("reconstructed_from_mtime");
    expect(by(page).provenance.providerId).toBe("inferred_from_payload_shape");
    expect(by(quote).providerId).toBe("intents-1click");
    expect(by(tokens).providerId).toBe("intents-1click");
    expect(by(price).providerId).toBe("coingecko");
  });

  it("links explorer pages to swap counts and quarantine skips only from recorded evidence", () => {
    expect(by(page).linkage.explorerSwaps).toMatchObject({ count: 7 });
    expect(by(page).provenance.linkage).toBe("postgres_explorer_swaps");
    expect(by(skippedPage).linkage).toEqual({ quarantinedSkipped: true });
    expect(by(skippedPage).linkage).not.toHaveProperty("pageNo");
  });

  it("skips corrupt and unclassifiable payloads instead of guessing, and the plan is deterministic", () => {
    expect(out.summary.skipped.corrupt).toEqual([bad]);
    expect(out.summary.skipped.unclassifiable).toBe(1); // junk
    expect(out.items.some((i) => i.hash === junk)).toBe(false);
    const again = planReconstruction([src], {
      skippedPageHashes: [skippedPage],
      swapLinkage: new Map([
        [
          page,
          { count: 7, minCreatedAt: "2026-11-01T00:00:00.000Z", maxCreatedAt: "2026-11-01T01:00:00.000Z" },
        ],
      ]),
    });
    expect(again.items.map((i) => i.hash)).toEqual(out.items.map((i) => i.hash));
  });
});
