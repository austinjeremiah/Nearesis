import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BigQueryLike } from "../../src/adapters/bigquery.ts";
import { assertGuardedSql } from "../../src/adapters/bigquery-guard.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { MemoryObjectStore } from "../../src/archive/object-store.ts";
import { accountRows } from "../../src/backfill/account-load.ts";
import { AccountStateStore, runAccountPhase } from "../../src/backfill/account-run.ts";
import { accountSql, planAccountChunks } from "../../src/backfill/account-sql.ts";
import { BudgetLedger, MIB } from "../../src/backfill/budget.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const prov = { rawObjectHash: "h", fetchedAtUTC: "2026-11-11T09:00:00.000Z" };

describe("account SQL", () => {
  it("passes the static guard, is partition bounded and uses no OR keyword", () => {
    const sql = accountSql({ from: "2026-10-01", to: "2026-11-01" });
    expect(() => assertGuardedSql(sql)).not.toThrow();
    expect(sql).not.toMatch(/\bOR\b/);
    expect(sql).toContain("intents.near");
    expect(sql).toContain(".omft.near");
  });
  it("plans 13 month chunks, newest first, covering 365 days", () => {
    const p = planAccountChunks();
    expect(p).toHaveLength(13);
    expect(p[0]?.id).toBe("account:2026-11-01");
    expect(p.at(-1)?.id).toBe("account:2025-11-10");
  });
  it("rejects a malformed date", () => {
    expect(() => accountSql({ from: "2026-10-01'; DROP", to: "2026-11-01" })).toThrow();
  });
});

describe("account rows", () => {
  it("derives the organic count and flags intents-majority heavy signers", () => {
    const { days, heavySigners } = accountRows(
      [
        {
          kind: "day",
          block_date: { value: "2026-10-01" },
          tx_total: 1000,
          tx_intents: 100,
          tx_bridge: 50,
          signers_total: 400,
          signers_with_intents: 3,
          signers_organic: 397,
          top1_count: 4,
          top1_tx: 200,
          top5_count: 20,
          top5_tx: 400,
        },
        {
          kind: "signer",
          block_date: { value: "2026-10-01" },
          signer: "relayer.near",
          tx_total: 2000,
          tx_intents: 1900,
          tx_bridge: 0,
        },
        {
          kind: "signer",
          block_date: { value: "2026-10-01" },
          signer: "bot.near",
          tx_total: 1500,
          tx_intents: 0,
          tx_bridge: 10,
        },
      ],
      prov,
    );
    expect(days[0]).toMatchObject({ tx_organic: "850", top1pct_organic_tx: "200", source_label: "LIVE" });
    expect(heavySigners.map((h) => h.intents_generated)).toEqual([1, 0]);
  });
  it("refuses inconsistent rows", () => {
    expect(() =>
      accountRows(
        [
          {
            kind: "day",
            block_date: "2026-10-01",
            tx_total: 10,
            tx_intents: 8,
            tx_bridge: 5,
            signers_total: 1,
            signers_with_intents: 1,
            signers_organic: 0,
            top1_count: 0,
            top1_tx: 0,
            top5_count: 0,
            top5_tx: 0,
          },
        ],
        prov,
      ),
    ).toThrow();
  });
});

describe("account phase budget and resume", () => {
  it("makes no billed job in dry-only mode, skips chunks that do not fit, caps jobs at 1.1 x estimate, and resumes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-"));
    dirs.push(dir);
    const calls: Array<{ dry: boolean; cap?: string }> = [];
    const est = (sql: string): number => (sql.includes("DATE '2026-10-01'") ? 500 * MIB : 10 * MIB);
    const bq: BigQueryLike = {
      getProjectId: async () => "p",
      getDatasetMetadata: async () => ({ location: "us-east1" }),
      async createQueryJob(o) {
        calls.push({ dry: !!o.dryRun, ...(o.maximumBytesBilled ? { cap: o.maximumBytesBilled } : {}) });
        const e = est(o.query);
        return [
          {
            id: `j${calls.length}`,
            metadata: {
              statistics: { totalBytesProcessed: String(e), query: { totalBytesBilled: String(e) } },
            },
            getQueryResults: async () => [
              [
                {
                  kind: "day",
                  block_date: "2026-11-01",
                  tx_total: 5,
                  tx_intents: 1,
                  tx_bridge: 0,
                  signers_total: 2,
                  signers_with_intents: 1,
                  signers_organic: 2,
                  top1_count: 1,
                  top1_tx: 3,
                  top5_count: 1,
                  top5_tx: 3,
                },
              ],
            ],
          },
        ];
      },
    };
    const archive = new RawArchive(new MemoryObjectStore(), null);
    const store = new AccountStateStore(join(dir, "s.json"));
    const chunks = planAccountChunks("2026-10-01", "2026-11-09").reverse().reverse();
    const dry = await runAccountPhase({
      bq,
      archive,
      ch: null,
      store,
      ledger: new BudgetLedger(0),
      location: "us-east1",
      chunks,
      dryOnly: true,
    });
    expect(dry.dryRun).toHaveLength(2);
    expect(calls.every((c) => c.dry)).toBe(true);
    // a second chunk will not fit: only 100 MiB left in a tiny ledger
    const inserted: unknown[] = [];
    const ch = { insert: async (o: { table: string; values: unknown[] }) => void inserted.push(o) } as never;
    const ledger = new BudgetLedger(0, 100 * MIB);
    const r = await runAccountPhase({
      bq,
      archive,
      ch,
      store,
      ledger,
      location: "us-east1",
      chunks,
      nowMs: () => Date.parse("2026-11-11T09:00:00Z"),
    });
    expect(r.completed).toEqual(["account:2026-11-01"]);
    expect(r.skippedForBudget.map((s) => s.id)).toEqual(["account:2026-10-01"]);
    const billedJob = calls.find((c) => !c.dry);
    expect(Number(billedJob?.cap)).toBe(Math.ceil(10 * MIB * 1.1));
    expect(new AccountStateStore(join(dir, "s.json")).isDone("account:2026-11-01")).toBe(true);
    // resume: the finished chunk is not re-run
    const n = calls.length;
    const r2 = await runAccountPhase({
      bq,
      archive,
      ch,
      store: new AccountStateStore(join(dir, "s.json")),
      ledger: new BudgetLedger(0),
      location: "us-east1",
      chunks,
      nowMs: () => Date.parse("2026-11-12T09:00:00Z"),
    });
    expect(r2.completed).toEqual(["account:2026-10-01"]);
    expect(calls.length - n).toBe(2); // one dry run + one billed job, nothing for the finished chunk
  });
});
