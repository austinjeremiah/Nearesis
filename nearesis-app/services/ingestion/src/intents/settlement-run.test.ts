import { describe, expect, it } from "vitest";
import type { RawArchive } from "../archive/archive.ts";
import { BudgetLedger, MIB } from "../backfill/budget.ts";
import {
  parseScratch,
  runSettlementPilot,
  settlementApprovalDigest,
  windowDays,
  type SettlementBq,
} from "./settlement-run.ts";

const W7 = { id: "7d", swapFrom: "2026-10-20", swapTo: "2026-10-26" };
const W6 = { id: "6d", swapFrom: "2026-10-20", swapTo: "2026-10-25" };
const W7b = { id: "7d-b", swapFrom: "2026-10-19", swapTo: "2026-10-25" };
const W30 = { id: "30d", swapFrom: "2026-09-27", swapTo: "2026-10-26" };
const SCRATCH = "proj.nearesis_scratch.settlement_hashes";
const H = ["GnLQcUzbZPZgXQK9wDZDsfwDGCYvDgLy1DBMGgcKKdYJ", "7QqxJ8Tg5pJw2ZzK3mFhNsd9Rw4cYeVb6uPaLxXn1kTq"];
const EST = 297 * MIB;

interface Rec {
  events: string[];
  jobs: Array<{ dryRun?: boolean; maximumBytesBilled?: string; labels?: unknown }>;
}
function fake(
  rec: Rec,
  o: {
    est?: number;
    billed?: number | null;
    blockBilled?: boolean;
    failQuery?: boolean;
    failDelete?: boolean;
  } = {},
) {
  const bq: SettlementBq = {
    getProjectId: async () => "proj",
    getDatasetMetadata: async () => ({ location: "us-east1" }),
    loadScratchTable: async () => void rec.events.push("load"),
    deleteScratchTable: async () => {
      rec.events.push("delete");
      if (o.failDelete) throw new Error("boom");
    },
    createQueryJob: async (opts) => {
      rec.jobs.push(opts);
      rec.events.push(opts.dryRun ? "dry" : "billed");
      if (opts.dryRun)
        return [{ metadata: { statistics: { totalBytesProcessed: String(o.est ?? EST) } } } as never];
      if (o.blockBilled)
        throw Object.assign(new Error("blocked"), {
          name: "CostBlockedError",
          detail: { costReason: "BUDGET" },
        });
      if (o.failQuery) throw new Error("query failed");
      return [
        {
          id: "job1",
          metadata: {
            statistics: {
              query: { totalBytesBilled: o.billed === null ? undefined : String(o.billed ?? EST) },
            },
          },
          getQueryResults: async () => [[{ tx_hash: H[0], block_ts_ns: 1 }]],
        } as never,
      ];
    },
  };
  return bq;
}
const archive = {
  archive: async () => ({ observation: { payloadObjectHash: "rawhash" } }),
} as unknown as RawArchive;
const base = (rec: Rec, o?: Parameters<typeof fake>[1]) => ({
  bq: fake(rec, o),
  archive,
  ledger: new BudgetLedger(0),
  location: "us-east1",
  window: W7,
  scratchTable: SCRATCH,
  hashes: H,
  approvalDigest: settlementApprovalDigest(W7, SCRATCH),
  approvedMaxBytes: 375_000_000,
  isDone: () => false,
  markDone: () => undefined,
});
const fresh = (): Rec => ({ events: [], jobs: [] });

describe("settlement pilot billed runner", () => {
  it("runs once with the approved digest: load, dry run, capped billed job, archive, mark done, cleanup", async () => {
    const rec = fresh();
    const done: unknown[] = [];
    const r = await runSettlementPilot({ ...base(rec), markDone: (d) => done.push(d) });
    expect(r.status).toBe("done");
    expect(rec.events).toEqual(["load", "dry", "billed", "delete"]);
    const billed = rec.jobs.find((j) => !j.dryRun)!;
    // per-job cap: the lower of the owner's ceiling and ceil(estimate x 1.1)
    expect(billed.maximumBytesBilled).toBe(String(Math.min(Math.ceil(EST * 1.1), 375_000_000)));
    expect(billed.labels).toEqual({ source: "nearesis_settlement_pilot" });
    expect(done).toHaveLength(1);
    expect(r.status === "done" && r.scratchCleanup).toBe("deleted");
  });
  it("the cap never exceeds the owner's ceiling", async () => {
    const rec = fresh();
    await runSettlementPilot({ ...base(rec, { est: 340_000_000 }), approvedMaxBytes: 350_000_000 });
    expect(rec.jobs.find((j) => !j.dryRun)!.maximumBytesBilled).toBe("350000000");
  });

  it("negative controls: no digest, wrong digest, no ceiling make zero BigQuery calls", async () => {
    for (const patch of [
      { approvalDigest: undefined },
      { approvalDigest: "0".repeat(64) },
      { approvedMaxBytes: undefined },
      { approvedMaxBytes: 0 },
      { approvedMaxBytes: Number.NaN },
    ]) {
      const rec = fresh();
      await expect(runSettlementPilot({ ...base(rec), ...patch })).rejects.toThrow(/approval|authorisation/);
      expect(rec.events).toEqual([]);
    }
  });
  it("a digest approved for the 7-day window cannot run another window or another scratch table", async () => {
    const d7 = settlementApprovalDigest(W7, SCRATCH);
    expect(settlementApprovalDigest(W7b, SCRATCH)).not.toBe(d7);
    expect(settlementApprovalDigest(W7, "proj.nearesis_scratch.settlement_hashes_2")).not.toBe(d7);
    for (const w of [W7b, W6, W30]) {
      const rec = fresh();
      await expect(runSettlementPilot({ ...base(rec), window: w, approvalDigest: d7 })).rejects.toThrow(
        /7 swap days|digest/,
      );
      expect(rec.events).toEqual([]);
    }
    // even with its own matching digest a 30-day window is not a pilot
    const rec = fresh();
    await expect(
      runSettlementPilot({
        ...base(rec),
        window: W30,
        approvalDigest: settlementApprovalDigest(W30, SCRATCH),
      }),
    ).rejects.toThrow(/exactly 7/);
    expect(windowDays(W7)).toBe(7);
    expect(rec.events).toEqual([]);
  });
  it("refuses scratch tables outside nearesis_scratch, and bad or empty hashes", async () => {
    expect(() => parseScratch("proj.prod.settlement_hashes")).toThrow();
    expect(() => parseScratch("proj.nearesis_scratch.users")).toThrow();
    const rec = fresh();
    await expect(
      runSettlementPilot({ ...base(rec), scratchTable: "proj.prod.settlement_hashes" }),
    ).rejects.toThrow(/scratch/);
    await expect(runSettlementPilot({ ...base(rec), hashes: [] })).rejects.toThrow(/hashes/);
    await expect(runSettlementPilot({ ...base(rec), hashes: ["x' OR 1=1"] })).rejects.toThrow(/hashes/);
    expect(rec.events).toEqual([]);
  });
  it("skips (no billed job) when the dry run exceeds approvedMaxBytes, and still deletes the scratch table", async () => {
    const rec = fresh();
    const r = await runSettlementPilot({ ...base(rec, { est: 400_000_000 }) });
    expect(r).toMatchObject({ status: "skipped", estimateBytes: 400_000_000, scratchCleanup: "deleted" });
    expect(rec.events).toEqual(["load", "dry", "delete"]);
  });
  it("quota guard: skips when the estimate does not fit the remaining daily budget", async () => {
    const rec = fresh();
    const ledger = new BudgetLedger(0, 100 * MIB);
    const r = await runSettlementPilot({ ...base(rec), ledger });
    expect(r).toMatchObject({ status: "skipped" });
    expect(r.status === "skipped" && r.reason).toMatch(/quota guard/);
    expect(rec.events).not.toContain("billed");
  });
  it("cost gate: a blocked spend is a clean skip with cleanup", async () => {
    const rec = fresh();
    const r = await runSettlementPilot({ ...base(rec, { blockBilled: true }) });
    expect(r.status === "skipped" && r.reason).toMatch(/cost governor: BUDGET/);
    expect(rec.events).toEqual(["load", "dry", "billed", "delete"]);
  });
  it("unknown billed bytes are charged at the cap, never zero", async () => {
    const rec = fresh();
    const ledger = new BudgetLedger(0);
    const r = await runSettlementPilot({ ...base(rec, { billed: null }), ledger });
    expect(r.status === "done" && r.done.billedBytes).toBe(Math.min(Math.ceil(EST * 1.1), 375_000_000));
    expect(ledger.billedToday).toBeGreaterThan(0);
  });
  it("cleans the scratch table when the query fails, and reports a failed cleanup instead of hiding it", async () => {
    const rec = fresh();
    await expect(runSettlementPilot({ ...base(rec, { failQuery: true }) })).rejects.toThrow(/query failed/);
    expect(rec.events).toEqual(["load", "dry", "billed", "delete"]);
    const rec2 = fresh();
    const r = await runSettlementPilot({ ...base(rec2, { failDelete: true }) });
    expect(r.status === "done" && r.scratchCleanup).toBe("failed");
  });
  it("is idempotent: an already-done window makes no BigQuery call", async () => {
    const rec = fresh();
    expect(await runSettlementPilot({ ...base(rec), isDone: () => true })).toEqual({
      status: "already_done",
    });
    expect(rec.events).toEqual([]);
  });
});
