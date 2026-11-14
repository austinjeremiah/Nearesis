import type { Row } from "../backfill/ch.ts";

/**
 * Pilot reconciliation checks (pure functions over parsed rows; no BigQuery). The pilot's value is these checks passing on
 * real days before the history is expanded. They never force agreement: they report it.
 */
const big = (v: unknown): bigint => BigInt(String(v));
const day = (r: Row): string => String(r.block_date);

export interface LeanVsFullDay {
  day: string;
  gasEqual: boolean;
  tokensEqual: boolean;
  outcomesEqual: boolean;
  leanZeroTokenOutcomes: bigint;
  fullRefundOutcomes: bigint;
  /** zero-token outcomes that are not refund receipts (the proxy's false positives). */
  zeroTokenNonRefund: bigint;
  /** refund receipts that burn tokens (the proxy's false negatives; expected 0). */
  refundWithTokens: bigint;
  proxyExact: boolean;
}

/** Lean (rule v2) vs A18 full (receipt_details join) rows of the SAME day(s): totals must match; the refund proxy is measured. */
export function compareLeanToFull(lean: Row[], full: Row[]): LeanVsFullDay[] {
  const days = [...new Set(full.map(day))].sort();
  return days.map((d) => {
    const L = lean.filter((r) => day(r) === d);
    const F = full.filter((r) => day(r) === d);
    const sum = (rs: Row[], f: string): bigint => rs.reduce((a, r) => a + big(r[f]), 0n);
    const leanZero = sum(
      L.filter((r) => r.outcome_kind === "ZERO_TOKEN"),
      "outcomes",
    );
    const refunds = F.filter((r) => r.outcome_kind === "REFUND");
    const fullRefund = sum(refunds, "outcomes");
    const fullZero = sum(F, "zero_token_rows");
    const refundWithTokens = sum(
      refunds.filter((r) => big(r.tokens_burnt_yocto) > 0n),
      "outcomes",
    );
    const zeroNonRefund = fullZero - sum(refunds, "zero_token_rows");
    return {
      day: d,
      gasEqual: sum(L, "gas_burnt") === sum(F, "gas_burnt"),
      tokensEqual: sum(L, "tokens_burnt_yocto") === sum(F, "tokens_burnt_yocto"),
      outcomesEqual: sum(L, "outcomes") === sum(F, "outcomes"),
      leanZeroTokenOutcomes: leanZero,
      fullRefundOutcomes: fullRefund,
      zeroTokenNonRefund: zeroNonRefund,
      refundWithTokens,
      proxyExact: leanZero === fullRefund && refundWithTokens === 0n,
    };
  });
}

export interface LeanVsConversionDay {
  day: string;
  txs: bigint;
  outcomes: bigint;
  conversionGas: bigint;
  conversionTokens: bigint;
  /** outcomes minus conversion; only meaningful if execution_outcomes includes the transaction outcomes (checked here). */
  impliedReceiptGas: bigint;
  impliedReceiptTokens: bigint;
  ok: boolean;
}

/** outcomes must contain at least the conversion burn and at least one outcome per transaction, else the inference is false. */
export function reconcileLeanToConversion(lean: Row[], conversion: Row[]): LeanVsConversionDay[] {
  return conversion
    .filter((r) => r.scope === "day")
    .map((c) => {
      const L = lean.filter((r) => day(r) === day(c));
      const sum = (f: string): bigint => L.reduce((a, r) => a + big(r[f]), 0n);
      const gas = sum("gas_burnt");
      const tok = sum("tokens_burnt_yocto");
      const n = sum("outcomes");
      const cg = big(c.conversion_gas);
      const ct = big(c.conversion_tokens_yocto);
      const txs = big(c.txs);
      return {
        day: day(c),
        txs,
        outcomes: n,
        conversionGas: cg,
        conversionTokens: ct,
        impliedReceiptGas: gas - cg,
        impliedReceiptTokens: tok - ct,
        ok: L.length > 0 && gas >= cg && tok >= ct && n >= txs,
      };
    });
}

export interface GasPriceCheck {
  day: string;
  ok: boolean;
  reason: string | null;
}

/** Gas price sanity: protocol range 1e8..2e9 yocto per gas, min <= mean <= max, sum = mean x blocks consistent. */
export function checkGasPriceRows(rows: Row[]): GasPriceCheck[] {
  return rows.map((r) => {
    const mn = big(r.min_gas_price_yocto);
    const mx = big(r.max_gas_price_yocto);
    const blocks = big(r.blocks);
    const sum = big(r.sum_gas_price_yocto);
    const inRange = mn >= 100_000_000n && mx <= 2_000_000_000n;
    const ordered = mn <= mx && sum >= mn * blocks && sum <= mx * blocks;
    return {
      day: day(r),
      ok: inRange && ordered,
      reason: !inRange ? "OUTSIDE_PROTOCOL_PRICE_RANGE" : !ordered ? "SUM_INCONSISTENT_WITH_MIN_MAX" : null,
    };
  });
}
