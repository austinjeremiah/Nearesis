import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { BigQueryLike } from "../adapters/bigquery.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { economicsGaps } from "./load.ts";
import { fmtUsd, ON_DEMAND_USD_PER_TIB, TIB, usdForBytes } from "./pricing.ts";
import { checkGasPriceRows, compareLeanToFull, reconcileLeanToConversion } from "./reconcile.ts";
import { conversionRows, outcomeRows } from "./rows.ts";
import { ECONOMICS_TABLES } from "./schema.ts";
import { planDigest, runEconomicsPhase } from "./run.ts";
import {
  conversionSql,
  ECONOMICS_FAMILIES,
  economicsSql,
  OPTIONAL_FAMILIES,
  outcomesFullSql,
  outcomesSql,
  planDailyChunks,
} from "./sql.ts";

const prov = { rawObjectHash: "h", fetchedAtUTC: "2026-11-13T09:00:00.000Z" };
const d = (v: string) => ({ value: v });
const c = { from: "2026-11-03", to: "2026-11-04" };

describe("lean SQL (rule version 2)", () => {
  it("lean families read one table each, no JOIN, no status, receipt_id or receipt JSON", () => {
    for (const sql of [outcomesSql(c), conversionSql(c)]) {
      expect(() => assertGuardedSql(sql)).not.toThrow();
      expect(sql).not.toMatch(/\bJOIN\b/i);
      expect(sql).not.toMatch(/receipt_details|receipt_origin_transaction/);
      expect(sql).not.toMatch(/\bstatus\b|\breceipt_id\b|logs|signature/);
      expect(sql).not.toMatch(/\bOR\b/);
    }
    expect(outcomesSql(c)).toContain("execution_outcomes");
    expect(conversionSql(c)).toContain("`bigquery-public-data.crypto_near_mainnet_us.transactions`");
  });
  it("projects only numeric and key columns of the source tables", () => {
    const cols = (sql: string) => new Set([...sql.matchAll(/\bx\.(\w+)/g)].map((m) => m[1]));
    expect(cols(outcomesSql(c))).toEqual(
      new Set(["block_date", "executor_account_id", "gas_burnt", "tokens_burnt"]),
    );
    expect(conversionSql(c)).toMatch(/receipt_conversion_gas_burnt/);
    expect(conversionSql(c)).toMatch(/receipt_conversion_tokens_burnt/);
    expect(conversionSql(c)).not.toMatch(/transaction_hash|signer|signature|public_key/);
  });
  it("keeps exact arithmetic: BIGNUMERIC sums, STRING output, no FLOAT sums of tokens", () => {
    for (const sql of [outcomesSql(c), conversionSql(c)]) {
      expect(sql).toMatch(/AS BIGNUMERIC/);
      expect(sql).toMatch(/AS STRING/);
      expect(sql).not.toMatch(/SUM\((x\.)?(gas|tokens)_burnt\)/);
    }
  });
  it("derives the refund proxy from tokens_burnt = 0, never from a join", () => {
    expect(outcomesSql(c)).toContain("x.tokens_burnt = 0 THEN 'ZERO_TOKEN'");
  });
  it("default plan is lean; the join families are optional and priced separately", () => {
    expect([...ECONOMICS_FAMILIES]).toEqual(["outcomes", "conversion", "gas_price"]);
    expect([...OPTIONAL_FAMILIES]).toEqual(["tx_cost", "outcomes_full"]);
    expect(outcomesFullSql(c)).toMatch(/receipt_details/);
    expect(economicsSql({ id: "x", family: "outcomes_full", ...c })).toBe(outcomesFullSql(c));
  });
  it("plans one chunk per day per family, newest day first", () => {
    const p = planDailyChunks("2026-11-03", "2026-11-10");
    expect(p).toHaveLength(21);
    expect(p[0]?.id).toBe("outcomes:2026-11-09");
    expect(p[6]?.id).toBe("outcomes:2026-11-03");
    expect(p[0]).toMatchObject({ from: "2026-11-09", to: "2026-11-10" });
    expect(() => planDailyChunks("2026-11-03'; DROP", "2026-11-10")).toThrow();
  });
});

describe("lean rows and reconciliation", () => {
  const leanRows = (kind: string, n: number, gas: string, tok: string) => ({
    block_date: d("2026-11-03"),
    executor_account_id: "a.near",
    outcome_kind: kind,
    status_class: "UNKNOWN",
    outcomes: n,
    gas_burnt: gas,
    tokens_burnt_yocto: tok,
    fractional_gas_rows: 0,
    zero_token_rows: kind === "ZERO_TOKEN" ? n : 0,
    duplicate_receipt_rows: 0,
  });
  const lean = outcomeRows(
    [
      leanRows("BURNING", 10, "1000", "123456789012345678901234"),
      leanRows("ZERO_TOKEN", 4, "892730250000", "0"),
    ],
    prov,
  );
  it("accepts lean kinds and UNKNOWN status, labels float64 precision", () => {
    expect(lean.every((r) => r.token_precision === "source_float64" && r.rule_version === 2)).toBe(true);
  });
  const full = (rows: Array<[string, number, string, string, number]>) =>
    outcomeRows(
      rows.map(([kind, n, g, t, z]) => ({
        ...leanRows(kind, n, g, t),
        status_class: "SUCCESS",
        zero_token_rows: z,
      })),
      prov,
    );
  it("compareLeanToFull: totals equal and the refund proxy is exact when zero-token = refunds", () => {
    const f = full([
      ["ACTION", 10, "1000", "123456789012345678901234", 0],
      ["REFUND", 4, "892730250000", "0", 4],
    ]);
    const [r] = compareLeanToFull(lean, f);
    expect(r).toMatchObject({ gasEqual: true, tokensEqual: true, outcomesEqual: true, proxyExact: true });
    expect(r?.zeroTokenNonRefund).toBe(0n);
  });
  it("compareLeanToFull measures the proxy's false positives instead of hiding them", () => {
    const f = full([
      ["ACTION", 8, "1000", "123456789012345678901234", 2],
      ["REFUND", 2, "892730250000", "0", 2],
      ["DATA", 4, "0", "0", 4],
    ]);
    const [r] = compareLeanToFull(lean, f);
    expect(r?.proxyExact).toBe(false);
    expect(r?.zeroTokenNonRefund).toBe(6n);
    expect(r?.gasEqual).toBe(true); // totals still agree: the proxy only affects the split
  });
  const conv = (day: string, gas: string, tok: string, txs: number) =>
    conversionRows(
      [
        {
          scope: "day",
          block_date: d(day),
          account: null,
          txs,
          conversion_gas: gas,
          conversion_tokens_yocto: tok,
          null_rows: 0,
        },
        {
          scope: "receiver",
          block_date: d(day),
          account: "x.near",
          txs: txs - 1,
          conversion_gas: "40",
          conversion_tokens_yocto: "4",
          null_rows: 0,
        },
        {
          scope: "receiver",
          block_date: d(day),
          account: "__below_threshold__",
          txs: 1,
          conversion_gas: String(BigInt(gas) - 40n),
          conversion_tokens_yocto: String(BigInt(tok) - 4n),
          null_rows: 0,
        },
      ],
      prov,
    );
  it("conversionRows enforces named + folded = day, and refuses a mismatch", () => {
    expect(conv("2026-11-03", "100", "10", 5)).toHaveLength(3);
    expect(() =>
      conversionRows(
        [
          {
            scope: "day",
            block_date: d("2026-11-03"),
            account: null,
            txs: 5,
            conversion_gas: "100",
            conversion_tokens_yocto: "10",
            null_rows: 0,
          },
          {
            scope: "receiver",
            block_date: d("2026-11-03"),
            account: "x",
            txs: 5,
            conversion_gas: "99",
            conversion_tokens_yocto: "10",
            null_rows: 0,
          },
        ],
        prov,
      ),
    ).toThrow(/sum/);
  });
  it("reconcileLeanToConversion infers receipt-only burn and fails when outcomes are below the conversion burn", () => {
    const ok = reconcileLeanToConversion(lean, conv("2026-11-03", "100", "10", 5));
    expect(ok[0]).toMatchObject({ ok: true, impliedReceiptGas: 892730251000n - 100n });
    const bad = reconcileLeanToConversion(lean, conv("2026-11-03", "892730251001", "10", 5));
    expect(bad[0]?.ok).toBe(false);
    expect(reconcileLeanToConversion(lean, conv("2026-11-03", "100", "10", 50))[0]?.ok).toBe(false); // fewer outcomes than txs
  });
  it("checkGasPriceRows: protocol range and consistency", () => {
    const row = (mn: string, mx: string, sum: string, blocks: string) => ({
      block_date: "2026-11-03",
      min_gas_price_yocto: mn,
      max_gas_price_yocto: mx,
      sum_gas_price_yocto: sum,
      blocks,
    });
    expect(checkGasPriceRows([row("100000000", "100000000", "1000000000", "10")])[0]?.ok).toBe(true);
    expect(checkGasPriceRows([row("1", "100000000", "1000", "10")])[0]?.reason).toBe(
      "OUTSIDE_PROTOCOL_PRICE_RANGE",
    );
    expect(checkGasPriceRows([row("100000000", "100000000", "5", "10")])[0]?.reason).toBe(
      "SUM_INCONSISTENT_WITH_MIN_MAX",
    );
  });
  it("records the refund split as a proxy gap for lean outcomes but not for conversion or gas price", () => {
    const g = economicsGaps("outcomes", { from: "2026-11-03", to: "2026-11-04" }, { outcomes: lean });
    expect(g.some((x) => x.reason_code === "REFUND_SPLIT_IS_PROXY")).toBe(true);
    const gc = economicsGaps(
      "conversion",
      { from: "2026-11-03", to: "2026-11-04" },
      { conversion: conv("2026-11-03", "100", "10", 5) },
    );
    expect(gc.filter((x) => x.state === "partial")).toHaveLength(0);
  });
});

describe("pricing and schema", () => {
  it("prices at USD 6.25 per TiB", () => {
    expect(ON_DEMAND_USD_PER_TIB).toBe(6.25);
    expect(usdForBytes(TIB)).toBe(6.25);
    expect(fmtUsd(usdForBytes(0.5 * TIB))).toBe("USD 3.13");
  });
  it("the committed migration 009 is generated from ECONOMICS_TABLES", () => {
    const f = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "migrations-live",
      "009_economics.sql",
    );
    const sql = readFileSync(f, "utf8");
    for (const t of ECONOMICS_TABLES) expect(sql).toContain(t);
    expect(sql).toContain("near_economics_conversion_daily");
  });
});

describe("billed runner authorisation", () => {
  const chunks = planDailyChunks("2026-11-03", "2026-11-05", ["gas_price"]);
  const calls: Array<{ dryRun?: boolean }> = [];
  const bq = {
    getProjectId: async () => "p",
    createQueryJob: async (o: { dryRun?: boolean }) => {
      calls.push(o);
      return [
        { metadata: { statistics: { totalBytesProcessed: "1000" } }, getQueryResults: async () => [[]] },
      ];
    },
  } as unknown as BigQueryLike;
  const base = {
    bq,
    archive: null as never,
    ch: null as never,
    ledger: new BudgetLedger(0),
    location: "us-east1",
    chunks,
    isDone: () => false,
    markDone: () => undefined,
  };
  it("refuses with a valid digest but no byte authorisation, and bills nothing", async () => {
    calls.length = 0;
    await expect(
      runEconomicsPhase({ ...base, approvalDigest: planDigest(chunks), approvedMaxBytes: undefined }),
    ).rejects.toThrow(/authorisation/);
    expect(calls).toHaveLength(0);
  });
  it("skips every chunk whose estimate would exceed the authorised bytes (dry runs only)", async () => {
    calls.length = 0;
    const r = await runEconomicsPhase({ ...base, approvalDigest: planDigest(chunks), approvedMaxBytes: 500 });
    expect(r.completed).toEqual([]);
    expect(r.skippedForBudget).toHaveLength(2);
    expect(calls.every((x) => x.dryRun === true)).toBe(true);
  });
});
