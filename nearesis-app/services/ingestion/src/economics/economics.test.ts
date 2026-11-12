import { describe, expect, it } from "vitest";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { BigQueryLike } from "../adapters/bigquery.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES, MIB } from "../backfill/budget.ts";
import { economicsGaps } from "./load.ts";
import { gasPriceRows, outcomeRows, txCostRows, uintStr } from "./rows.ts";
import { ECONOMICS_TABLE_NAMES, ECONOMICS_TABLES } from "./schema.ts";
import { packIntoQuotaDays, planDigest, planFittingChunks, runEconomicsPhase } from "./run.ts";
import {
  economicsSql,
  gasPriceSql,
  outcomesFullSql,
  outcomesSql,
  planDailyChunks,
  planEconomicsChunks,
  splitChunk,
  txCostSql,
  type EconomicsChunk,
} from "./sql.ts";

const prov = { rawObjectHash: "h", fetchedAtUTC: "2026-11-13T09:00:00.000Z" };
const day = (d: string) => ({ value: d });

describe("economics SQL", () => {
  const c = { from: "2026-10-01", to: "2026-11-01" };
  it("every family passes the static guard, is block_date bounded, and uses no OR keyword", () => {
    for (const sql of [outcomesSql(c), txCostSql(c), gasPriceSql(c)]) {
      expect(() => assertGuardedSql(sql)).not.toThrow();
      expect(sql).not.toMatch(/\bOR\b/);
      expect(sql).not.toMatch(/\bSELECT\s+\*\s+FROM\s+`bigquery/i); // no unbounded star reads of source tables
    }
  });
  it("keeps big integers out of FLOAT64/INT64 sums (BIGNUMERIC/NUMERIC, output as STRING)", () => {
    const sql = outcomesSql(c) + txCostSql(c);
    expect(sql).toContain("CAST(x.tokens_burnt AS BIGNUMERIC)");
    expect(sql).toContain("CAST(SUM(t) AS STRING)");
    expect(sql).not.toMatch(/SUM\(x\.(gas|tokens)_burnt\)/);
  });
  it("never reads the receipt JSON column", () => {
    expect(outcomesFullSql(c)).not.toMatch(/\.receipt\b|d\.receipt\s/);
  });
  it("tx-cost looks RECEIPT_LOOKAHEAD_DAYS past the chunk for delayed receipts", () => {
    expect(txCostSql(c)).toContain("DATE '2026-11-03'");
  });
  it("rejects a malformed date (injection)", () => {
    expect(() => outcomesSql({ from: "2026-10-01'; DROP", to: "2026-11-01" })).toThrow();
  });
  it("plans 13 month chunks per default family (outcomes, conversion, gas_price), newest first", () => {
    const p = planEconomicsChunks();
    expect(p).toHaveLength(39);
    expect(p[0]?.id).toBe("outcomes:2026-11-01");
    expect(p.at(-1)?.id).toBe("gas_price:2025-11-10");
  });
  it("splits a chunk at the midpoint without losing or overlapping days", () => {
    const ch: EconomicsChunk = {
      id: "outcomes:2026-01-01",
      family: "outcomes",
      from: "2026-01-01",
      to: "2026-02-01",
    };
    const [a, b] = splitChunk(ch) as [EconomicsChunk, EconomicsChunk];
    expect(a.from).toBe("2026-01-01");
    expect(a.to).toBe(b.from);
    expect(b.to).toBe("2026-02-01");
    expect(splitChunk({ ...ch, to: "2026-01-02" })).toBeNull();
  });
});

describe("row parsing: exact arithmetic", () => {
  it("keeps yoctoNEAR above 2^53 exactly as strings", () => {
    const big = "123456789012345678901234567";
    expect(uintStr(big, "t")).toBe(big);
    expect(uintStr("7032494768750000000000.0", "t")).toBe("7032494768750000000000");
    expect(() => uintStr("1.5", "t")).toThrow();
    expect(() => uintStr("-1", "t")).toThrow();
    expect(() => uintStr(Number.MAX_SAFE_INTEGER + 2, "t")).toThrow(); // unsafe JS number is refused, not rounded
  });
  it("parses outcome rows and refuses unknown kinds", () => {
    const row = {
      block_date: day("2026-10-01"),
      executor_account_id: "aurora",
      outcome_kind: "ACTION",
      status_class: "FAILURE",
      outcomes: 3,
      gas_burnt: "8602766318",
      tokens_burnt_yocto: "860276631800000000000",
      fractional_gas_rows: 0,
      zero_token_rows: 0,
      duplicate_receipt_rows: 0,
    };
    const [r] = outcomeRows([row], prov);
    expect(r?.tokens_burnt_yocto).toBe("860276631800000000000");
    expect(r?.token_precision).toBe("source_float64");
    expect(r?.source_label).toBe("LIVE");
    expect(() => outcomeRows([{ ...row, outcome_kind: "MYSTERY" }], prov)).toThrow();
  });
});

const dayRow = (o: Record<string, unknown> = {}) => ({
  kind: "day",
  block_date: day("2026-10-01"),
  account: null,
  txs: 3,
  receipts: 7,
  txs_with_failed_receipt: 1,
  txs_without_receipt_rows: 0,
  conversion_gas: "900",
  conversion_tokens_yocto: "90000000000000000000000",
  receipt_gas: "2100",
  receipt_tokens_yocto: "210000000000000000000000",
  total_gas: "3000",
  total_tokens_yocto: "300000000000000000000000",
  max_gas: "2000",
  max_tokens_yocto: "200000000000000000000000",
  tokens_p50: "1",
  tokens_p90: "2",
  tokens_p99: "3",
  tokens_p999: "4",
  gas_p50: "1",
  gas_p90: "2",
  gas_p99: "3",
  gas_p999: "4",
  ...o,
});
const recvRow = (
  acct: string,
  txs: number,
  rc: number,
  g: string,
  t: string,
  cg: string,
  ct: string,
  rg: string,
  rt: string,
) => ({
  kind: "receiver",
  block_date: day("2026-10-01"),
  account: acct,
  txs,
  receipts: rc,
  txs_with_failed_receipt: 0,
  txs_without_receipt_rows: 0,
  conversion_gas: cg,
  conversion_tokens_yocto: ct,
  receipt_gas: rg,
  receipt_tokens_yocto: rt,
  total_gas: g,
  total_tokens_yocto: t,
  max_gas: g,
  max_tokens_yocto: t,
});
const topRow = (rank: number, hash: string, t: string) => ({
  kind: "top_tx",
  block_date: day("2026-10-01"),
  account: "dex.near",
  tx_hash: hash,
  signer_id: "alice.near",
  tx_gas: "1000",
  tx_tokens_yocto: t,
  tx_receipts: 4,
});

describe("tx-cost rows: reconciliation invariants", () => {
  const good = [
    dayRow({ txs_with_failed_receipt: 0 }),
    recvRow(
      "dex.near",
      2,
      5,
      "2000",
      "200000000000000000000000",
      "600",
      "60000000000000000000000",
      "1400",
      "140000000000000000000000",
    ),
    recvRow(
      "__below_threshold__",
      1,
      2,
      "1000",
      "100000000000000000000000",
      "300",
      "30000000000000000000000",
      "700",
      "70000000000000000000000",
    ),
    topRow(1, "tx1", "200000000000000000000000"),
    topRow(2, "tx2", "100000000000000000000000"),
  ];
  it("accepts rows where per-receiver sums equal the daily total (named + folded)", () => {
    const r = txCostRows(good, prov);
    expect(r.days).toHaveLength(1);
    expect(r.receivers).toHaveLength(2);
    expect(r.topTx.map((t) => t.rank)).toEqual([1, 2]);
    expect(r.days[0]?.percentile_method).toBe("bigquery_approx_quantiles_1000");
  });
  it("rejects a per-receiver set that does not sum to the daily total", () => {
    const broken = [...good];
    broken[1] = recvRow(
      "dex.near",
      2,
      5,
      "2000",
      "200000000000000000000000",
      "600",
      "60000000000000000000000",
      "1400",
      "140000000000000000000000",
    );
    broken[2] = recvRow(
      "__below_threshold__",
      1,
      2,
      "999",
      "99999999999999999999999",
      "299",
      "29999999999999999999999",
      "700",
      "70000000000000000000000",
    );
    expect(() => txCostRows(broken, prov)).toThrow(/sum|differs/);
  });
  it("rejects total != conversion + receipt (units never silently diverge)", () => {
    expect(() => txCostRows([dayRow({ total_gas: "3001" })], prov)).toThrow(/gas total/);
    expect(() => txCostRows([dayRow({ total_tokens_yocto: "300000000000000000000001" })], prov)).toThrow(
      /token total/,
    );
  });
  it("rejects top transactions out of rank order and a day without receiver rows", () => {
    const unordered = [
      ...good.slice(0, 3),
      topRow(1, "tx1", "100000000000000000000000"),
      topRow(2, "tx2", "200000000000000000000000"),
    ];
    expect(() => txCostRows(unordered, prov)).toThrow(/ordered/);
    expect(() => txCostRows([dayRow()], prov)).toThrow(/receiver/);
  });
});

describe("gas price rows and gaps", () => {
  const price = {
    block_date: day("2026-10-01"),
    blocks: 86400,
    min_gas_price: 100000000,
    max_gas_price: 100000000,
    sum_gas_price: "8640000000000",
    fractional_price_rows: 0,
    null_price_rows: 0,
    distinct_prices: 1,
  };
  it("keeps the sum exact and refuses a day with no blocks", () => {
    const [r] = gasPriceRows([price], prov);
    expect(r?.sum_gas_price_yocto).toBe("8640000000000");
    expect(() => gasPriceRows([{ ...price, blocks: 0 }], prov)).toThrow();
  });
  it("records provider gaps as unavailable (never zero) and odd structures as partial, plus the refund limitation", () => {
    const outcomes = outcomeRows(
      [
        {
          block_date: day("2026-10-02"),
          executor_account_id: "a",
          outcome_kind: "REFUND",
          status_class: "SUCCESS",
          outcomes: 5,
          gas_burnt: "220000000000",
          tokens_burnt_yocto: "0",
          fractional_gas_rows: 0,
          zero_token_rows: 5,
          duplicate_receipt_rows: 2,
        },
      ],
      prov,
    );
    const gaps = economicsGaps("outcomes", { from: "2026-10-01", to: "2026-10-04" }, { outcomes });
    const by = (r: string) => gaps.filter((g) => g.reason_code === r);
    expect(by("PROVIDER_GAP").map((g) => g.from_utc.slice(0, 10))).toEqual(["2026-10-01", "2026-10-03"]);
    expect(by("PROVIDER_GAP").every((g) => g.state === "unavailable")).toBe(true);
    expect(by("DUPLICATE_RECEIPT_DETAILS")).toHaveLength(1);
    expect(by("REFUND_VALUE_NOT_DERIVED")).toHaveLength(1);
  });
  it("flags transactions whose receipts were not found", () => {
    const t = txCostRows(
      [
        dayRow({ txs_without_receipt_rows: 2, txs_with_failed_receipt: 0 }),
        recvRow(
          "dex.near",
          3,
          7,
          "3000",
          "300000000000000000000000",
          "900",
          "90000000000000000000000",
          "2100",
          "210000000000000000000000",
        ),
      ].map((r, i) => (i === 1 ? { ...r, txs_without_receipt_rows: 2 } : r)),
      prov,
    );
    const gaps = economicsGaps("tx_cost", { from: "2026-10-01", to: "2026-10-02" }, { days: t.days });
    expect(gaps.some((g) => g.reason_code === "TX_WITHOUT_RECEIPT_OUTCOMES" && g.state === "partial")).toBe(
      true,
    );
  });
});

describe("schema", () => {
  it("has no floating point column types and one table per dataset name", () => {
    expect(ECONOMICS_TABLES).toHaveLength(ECONOMICS_TABLE_NAMES.length);
    for (const ddl of ECONOMICS_TABLES) {
      expect(ddl).not.toMatch(/\bFloat(32|64)\b/i);
      expect(ddl).toContain("ReplacingMergeTree(version)");
    }
    for (const n of ECONOMICS_TABLE_NAMES)
      expect(ECONOMICS_TABLES.some((d) => d.includes(`EXISTS ${n}\n`))).toBe(true);
  });
});

describe("budgeted runner (no billed query without approval)", () => {
  const chunks = planEconomicsChunks("2026-10-01", "2026-10-31", ["gas_price"]);
  const fakeBq = (calls: Array<{ dryRun?: boolean }>): BigQueryLike =>
    ({
      getProjectId: async () => "p",
      getDatasetMetadata: async () => ({ location: "us-east1" }),
      createQueryJob: async (o: { dryRun?: boolean }) => {
        calls.push(o);
        return [
          { metadata: { statistics: { totalBytesProcessed: "1000" } }, getQueryResults: async () => [[]] },
        ];
      },
    }) as unknown as BigQueryLike;
  it("refuses to bill without the digest of the exact approved SQL", async () => {
    const calls: Array<{ dryRun?: boolean }> = [];
    const base = {
      bq: fakeBq(calls),
      archive: null as never,
      ch: null as never,
      ledger: new BudgetLedger(0),
      location: "us-east1",
      chunks,
      approvedMaxBytes: 1_000_000,
      isDone: () => false,
      markDone: () => undefined,
    };
    await expect(runEconomicsPhase({ ...base, approvalDigest: undefined })).rejects.toThrow(/approval/);
    await expect(runEconomicsPhase({ ...base, approvalDigest: "0".repeat(64) })).rejects.toThrow(/approval/);
    expect(calls).toHaveLength(0);
  });
  it("a digest approved for the 7-day pilot window cannot run a different window", async () => {
    const pilot = planDailyChunks("2026-11-03", "2026-11-10", ["gas_price"]);
    const other = planDailyChunks("2026-11-04", "2026-11-11", ["gas_price"]);
    const longer = planDailyChunks("2026-11-03", "2026-11-17", ["gas_price"]);
    const subset = pilot.slice(0, 6);
    const approved = planDigest(pilot);
    for (const c of [other, longer, subset, [...pilot].reverse()]) {
      expect(planDigest(c)).not.toBe(approved);
      const calls: Array<{ dryRun?: boolean }> = [];
      await expect(
        runEconomicsPhase({
          bq: fakeBq(calls),
          archive: null as never,
          ch: null as never,
          ledger: new BudgetLedger(0),
          location: "us-east1",
          chunks: c,
          approvalDigest: approved,
          approvedMaxBytes: 1_000_000,
          isDone: () => false,
          markDone: () => undefined,
        }),
      ).rejects.toThrow(/does not match/);
      expect(calls).toHaveLength(0);
    }
  });
  it("refuses without approvedMaxBytes, enforces it, and sets maximumBytesBilled on every billed job", async () => {
    const pilot = planDailyChunks("2026-11-03", "2026-11-05", ["gas_price"]);
    const calls: Array<{ dryRun?: boolean; maximumBytesBilled?: string }> = [];
    const mk = (approvedMaxBytes: number | undefined, est = 1000) => ({
      bq: {
        getProjectId: async () => "p",
        getDatasetMetadata: async () => ({ location: "us-east1" }),
        createQueryJob: async (o: { dryRun?: boolean; maximumBytesBilled?: string }) => {
          calls.push(o);
          return [
            {
              metadata: {
                statistics: { totalBytesProcessed: String(est), query: { totalBytesBilled: String(est) } },
              },
              getQueryResults: async () => [[]],
            },
          ];
        },
      } as unknown as BigQueryLike,
      archive: { archive: async () => ({ observation: { payloadObjectHash: "h" } }) } as never,
      ch: { insert: async () => undefined, query: async () => ({ json: async () => [] }) } as never,
      ledger: new BudgetLedger(0),
      location: "us-east1",
      chunks: pilot,
      approvalDigest: planDigest(pilot),
      approvedMaxBytes,
      isDone: () => false,
      markDone: () => undefined,
    });
    await expect(runEconomicsPhase(mk(undefined))).rejects.toThrow(/approvedMaxBytes/);
    await expect(runEconomicsPhase(mk(0))).rejects.toThrow(/approvedMaxBytes/);
    expect(calls).toHaveLength(0);
    // ceiling of 10 MiB + 1500 B: the first chunk fits, the second would exceed the total and is skipped without a billed job
    let r;
    try {
      r = await runEconomicsPhase(mk(10 * 1024 * 1024 + 1500)); // each tiny job counts at the 10 MiB billed minimum
    } catch {
      /* loading into the stub ClickHouse is not under test */
    }
    const billed = calls.filter((c) => !c.dryRun);
    expect(billed).toHaveLength(1);
    for (const b of billed) expect(b.maximumBytesBilled).toBe(String(10 * 1024 * 1024)); // 1.1 x 1000 B is below the 10 MiB billing minimum
    if (r) expect(r.skippedForBudget).toHaveLength(1);
  });
  it("digest changes when the SQL changes", () => {
    expect(planDigest(chunks)).toBe(planDigest(chunks));
    expect(planDigest(chunks)).not.toBe(
      planDigest(planEconomicsChunks("2026-10-01", "2026-10-31", ["outcomes"])),
    );
  });
  it("dry-run planning issues only dry runs and halves chunks that exceed a quota day", async () => {
    const seen: Array<boolean | undefined> = [];
    const sizes = new Map<string, number>();
    const bq = {
      getProjectId: async () => "p",
      getDatasetMetadata: async () => ({ location: "us-east1" }),
      createQueryJob: async (o: { dryRun?: boolean; query: string }) => {
        seen.push(o.dryRun);
        const m = /DATE '(\d{4}-\d{2}-\d{2})' AND block_date < DATE '(\d{4}-\d{2}-\d{2})'/.exec(o.query);
        const days = (Date.parse(m?.[2] as string) - Date.parse(m?.[1] as string)) / 86_400_000;
        sizes.set(o.query, days);
        return [{ metadata: { statistics: { totalBytesProcessed: String(days * 4000 * MIB) } } }];
      },
    } as unknown as BigQueryLike;
    const one = planEconomicsChunks("2026-10-01", "2026-10-31", ["gas_price"]);
    const r = await planFittingChunks({
      bq,
      location: "us-east1",
      chunks: one,
      limitBytes: DAILY_LIMIT_BYTES,
    });
    expect(seen.every((x) => x === true)).toBe(true);
    expect(r.chunks.length).toBeGreaterThan(1); // 31 x 4000 MiB > 95 GiB: split
    expect(r.dry.every((d) => d.estimateBytes * 1.02 <= DAILY_LIMIT_BYTES)).toBe(true);
    expect(r.chunks.map((c) => economicsSql(c)).join()).toBeTruthy();
  });
  it("packs estimates into quota days at 95% with the 2% margin and reports oversize chunks", () => {
    const g = 1024 * MIB;
    const r = packIntoQuotaDays(
      [
        { id: "a", estimateBytes: 60 * g },
        { id: "b", estimateBytes: 40 * g },
        { id: "c", estimateBytes: 30 * g },
        { id: "huge", estimateBytes: 99 * g },
      ],
      DAILY_LIMIT_BYTES,
    );
    expect(r.days.map((d) => d.chunks)).toEqual([["a"], ["b", "c"]]);
    expect(r.oversize).toEqual(["huge"]);
  });
});
