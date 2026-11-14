import type { ClickHouseClient } from "@clickhouse/client";
import type { BqRow } from "../backfill/bq-runner.ts";
import { coverageRows, insertLive, type Provenance, type Row } from "../backfill/ch.ts";
import { addDays } from "../backfill/plan.ts";
import { conversionRows, gasPriceRows, outcomeRows, txCostRows } from "./rows.ts";
import type { EconomicsChunk, EconomicsFamily } from "./sql.ts";

export const ECONOMICS_DATASET: Record<EconomicsFamily, string> = {
  outcomes: "near_economics_outcomes_daily",
  conversion: "near_economics_conversion_daily",
  outcomes_full: "near_economics_outcomes_daily", // validation only: never loaded (see loadEconomicsChunk)
  tx_cost: "near_economics_tx_daily",
  gas_price: "near_economics_gas_price_daily",
};

export interface EconomicsGap {
  dataset: string;
  from_utc: string;
  to_utc: string;
  state: "partial" | "unavailable";
  reason_code: string;
}

export function chunkDays(c: Pick<EconomicsChunk, "from" | "to">): string[] {
  const out: string[] = [];
  for (let d = c.from; d < c.to; d = addDays(d, 1)) out.push(d);
  return out;
}
const dayRange = (day: string) => ({ from_utc: `${day}T00:00:00.000Z`, to_utc: `${day}T23:59:59.999Z` });
const num = (v: unknown): bigint => BigInt(String(v));

/**
 * Quality gaps implied by a chunk's rows. Never silently zero: a day the source returned nothing for is `unavailable`;
 * days with odd structures are `partial` with a reason code. REFUND_VALUE_NOT_DERIVED is always recorded for the chunk
 * because refund NEAR amounts live in the receipt JSON, which this build does not scan (it counts refund receipts only).
 */
export function economicsGaps(
  family: EconomicsFamily,
  chunk: Pick<EconomicsChunk, "from" | "to">,
  rows: { outcomes?: Row[]; days?: Row[]; prices?: Row[]; conversion?: Row[] },
): EconomicsGap[] {
  const gaps: EconomicsGap[] = [];
  const dataset = ECONOMICS_DATASET[family];
  const present = new Set<string>();
  const flag = (day: string, reason: string, state: "partial" | "unavailable" = "partial"): void => {
    gaps.push({ dataset, ...dayRange(day), state, reason_code: reason });
  };
  if (family === "conversion") {
    for (const r of rows.conversion ?? []) {
      const d = r.block_date as string;
      present.add(d);
      if (r.scope === "day" && num(r.null_rows) > 0n) flag(d, "NULL_CONVERSION_FIELDS");
    }
  } else if (family === "outcomes" || family === "outcomes_full") {
    const perDay = new Map<string, { frac: bigint; dup: bigint }>();
    for (const r of rows.outcomes ?? []) {
      const d = r.block_date as string;
      present.add(d);
      const a = perDay.get(d) ?? { frac: 0n, dup: 0n };
      a.frac += num(r.fractional_gas_rows);
      a.dup += num(r.duplicate_receipt_rows);
      perDay.set(d, a);
    }
    for (const [d, a] of perDay) {
      if (a.frac > 0n) flag(d, "FRACTIONAL_GAS_ROWS");
      if (a.dup > 0n) flag(d, "DUPLICATE_RECEIPT_DETAILS");
    }
  } else if (family === "tx_cost") {
    for (const r of rows.days ?? []) {
      const d = r.block_date as string;
      present.add(d);
      if (num(r.txs_without_receipt_rows) > 0n) flag(d, "TX_WITHOUT_RECEIPT_OUTCOMES");
    }
  } else {
    for (const r of rows.prices ?? []) {
      const d = r.block_date as string;
      present.add(d);
      if (num(r.fractional_price_rows) > 0n || num(r.null_price_rows) > 0n) flag(d, "GAS_PRICE_ODD_VALUES");
    }
  }
  for (const d of chunkDays(chunk)) if (!present.has(d)) flag(d, "PROVIDER_GAP", "unavailable");
  if (family === "outcomes")
    gaps.push({
      dataset,
      from_utc: `${chunk.from}T00:00:00.000Z`,
      to_utc: `${addDays(chunk.to, -1)}T23:59:59.999Z`,
      state: "partial",
      reason_code: "REFUND_SPLIT_IS_PROXY",
    });
  if (family === "outcomes" || family === "tx_cost" || family === "outcomes_full")
    gaps.push({
      dataset,
      from_utc: `${chunk.from}T00:00:00.000Z`,
      to_utc: `${addDays(chunk.to, -1)}T23:59:59.999Z`,
      state: "partial",
      reason_code: "REFUND_VALUE_NOT_DERIVED",
    });
  return gaps;
}

/** Idempotent (ReplacingMergeTree) load of one chunk, plus source_coverage and quality_gaps rows. */
export async function loadEconomicsChunk(
  ch: ClickHouseClient,
  chunk: EconomicsChunk,
  bqRows: BqRow[],
  p: Provenance,
): Promise<number> {
  let n = 0;
  // Validation-only family: archived by the runner, compared by compareLeanToFull, never loaded.
  if (chunk.family === "outcomes_full") return outcomeRows(bqRows, p).length;
  let gaps: EconomicsGap[];
  let present: Set<string>;
  if (chunk.family === "outcomes") {
    const outcomes = outcomeRows(bqRows, p);
    n += await insertLive(ch, "near_economics_outcomes_daily", outcomes);
    gaps = economicsGaps("outcomes", chunk, { outcomes });
    present = new Set(outcomes.map((r) => r.block_date as string));
  } else if (chunk.family === "conversion") {
    const conv = conversionRows(bqRows, p);
    n += await insertLive(ch, "near_economics_conversion_daily", conv);
    gaps = economicsGaps("conversion", chunk, { conversion: conv });
    present = new Set(conv.map((r) => r.block_date as string));
  } else if (chunk.family === "tx_cost") {
    const t = txCostRows(bqRows, p);
    n += await insertLive(ch, "near_economics_tx_daily", t.days);
    n += await insertLive(ch, "near_economics_tx_receiver_daily", t.receivers);
    n += await insertLive(ch, "near_economics_top_tx", t.topTx);
    gaps = economicsGaps("tx_cost", chunk, { days: t.days });
    present = new Set(t.days.map((r) => r.block_date as string));
  } else {
    const prices = gasPriceRows(bqRows, p);
    n += await insertLive(ch, "near_economics_gas_price_daily", prices);
    gaps = economicsGaps("gas_price", chunk, { prices });
    present = new Set(prices.map((r) => r.block_date as string));
  }
  const v = Date.parse(p.fetchedAtUTC);
  const dataset = ECONOMICS_DATASET[chunk.family];
  const partialDays = new Set(
    gaps
      .filter(
        (g) =>
          g.state === "partial" &&
          g.reason_code !== "REFUND_VALUE_NOT_DERIVED" &&
          g.reason_code !== "REFUND_SPLIT_IS_PROXY",
      )
      .map((g) => g.from_utc.slice(0, 10)),
  );
  await insertLive(
    ch,
    "source_coverage",
    coverageRows(
      chunkDays(chunk).map((day) => ({
        provider_id: "near-bigquery",
        dataset,
        day,
        state: !present.has(day)
          ? ("unavailable" as const)
          : partialDays.has(day)
            ? ("partial" as const)
            : ("complete" as const),
        reason: !present.has(day) ? "PROVIDER_GAP" : null,
        version: v,
      })),
    ),
  );
  await insertLive(
    ch,
    "quality_gaps",
    gaps.map((g) => ({
      provider_id: "near-bigquery",
      dataset: g.dataset,
      from_utc: g.from_utc,
      to_utc: g.to_utc,
      state: g.state,
      reason_code: g.reason_code,
      source_label: "LIVE",
      version: v,
    })),
  );
  return n;
}
