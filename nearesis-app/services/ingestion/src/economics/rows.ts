import { IngestionError } from "../errors.ts";
import type { BqRow } from "../backfill/bq-runner.ts";
import { bqScalar, type Provenance, type Row } from "../backfill/ch.ts";
import { ECONOMICS_RULE_VERSION, FOLDED_ACCOUNT, TOP_TX_PER_DAY } from "./sql.ts";

const bad = (reason: string, field: string): never => {
  throw new IngestionError("INVALID_INPUT", false, { reason, field });
};

/** Unsigned integer string; "123.0" style output is normalised, any real fraction is refused (units are integers). */
export function uintStr(v: unknown, field: string): string {
  const s = bqScalar(v, field);
  const m = /^(\d+)(?:\.0+)?$/.exec(s);
  if (!m) return bad("not an unsigned integer", field);
  return BigInt(m[1] as string).toString();
}
const big = (v: unknown, field: string): bigint => BigInt(uintStr(v, field));
const dayOf = (v: unknown): string => {
  const s = bqScalar(v, "block_date").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return bad("not a date", "block_date");
  return s;
};
const text = (v: unknown, field: string): string => {
  if (typeof v === "string" && v.length > 0) return v;
  return bad("missing text", field);
};
const prov = (p: Provenance) => ({
  source_label: "LIVE",
  raw_object_hash: p.rawObjectHash,
  fetched_at: p.fetchedAtUTC,
  version: Date.parse(p.fetchedAtUTC),
  rule_version: ECONOMICS_RULE_VERSION,
});

const KINDS = new Set(["ACTION", "DATA", "REFUND", "NO_RECEIPT_ROW"]);
const STATUS = new Set(["SUCCESS", "FAILURE", "OTHER"]);

export function outcomeRows(rows: BqRow[], p: Provenance): Row[] {
  return rows.map((r) => {
    const kind = text(r.outcome_kind, "outcome_kind");
    const st = text(r.status_class, "status_class");
    if (!KINDS.has(kind) || !STATUS.has(st)) bad("unknown outcome kind or status class", "kind");
    return {
      block_date: dayOf(r.block_date),
      executor_account_id: text(r.executor_account_id, "executor_account_id"),
      outcome_kind: kind,
      status_class: st,
      outcomes: uintStr(r.outcomes, "outcomes"),
      gas_burnt: uintStr(r.gas_burnt, "gas_burnt"),
      tokens_burnt_yocto: uintStr(r.tokens_burnt_yocto, "tokens_burnt_yocto"),
      fractional_gas_rows: uintStr(r.fractional_gas_rows, "fractional_gas_rows"),
      zero_token_rows: uintStr(r.zero_token_rows, "zero_token_rows"),
      duplicate_receipt_rows: uintStr(r.duplicate_receipt_rows, "duplicate_receipt_rows"),
      token_precision: "source_float64",
      ...prov(p),
    };
  });
}

export interface TxCostRows {
  days: Row[];
  receivers: Row[];
  topTx: Row[];
}

const SUM_FIELDS = [
  "txs",
  "receipts",
  "txs_with_failed_receipt",
  "txs_without_receipt_rows",
  "conversion_gas",
  "conversion_tokens_yocto",
  "receipt_gas",
  "receipt_tokens_yocto",
  "total_gas",
  "total_tokens_yocto",
] as const;

/** Splits the tx-cost output, enforces internal arithmetic (total = conversion + receipts, receiver rows sum to the day row). */
export function txCostRows(rows: BqRow[], p: Provenance): TxCostRows {
  const out: TxCostRows = { days: [], receivers: [], topTx: [] };
  const recvSum = new Map<string, Record<string, bigint>>();
  const topCount = new Map<string, number>();
  for (const r of rows) {
    const day = dayOf(r.block_date);
    if (r.kind === "day" || r.kind === "receiver") {
      const sums: Record<string, string> = {};
      for (const f of SUM_FIELDS) sums[f] = uintStr(r[f], f);
      if (
        BigInt(sums.conversion_gas as string) + BigInt(sums.receipt_gas as string) !==
        BigInt(sums.total_gas as string)
      )
        bad("gas total differs from conversion + receipts", "total_gas");
      if (
        BigInt(sums.conversion_tokens_yocto as string) + BigInt(sums.receipt_tokens_yocto as string) !==
        BigInt(sums.total_tokens_yocto as string)
      )
        bad("token total differs from conversion + receipts", "total_tokens_yocto");
      const base = {
        block_date: day,
        ...sums,
        max_gas: uintStr(r.max_gas, "max_gas"),
        max_tokens_yocto: uintStr(r.max_tokens_yocto, "max_tokens_yocto"),
        token_precision: "source_float64",
        ...prov(p),
      };
      if (r.kind === "day") {
        out.days.push({
          ...base,
          tokens_p50: uintStr(r.tokens_p50, "tokens_p50"),
          tokens_p90: uintStr(r.tokens_p90, "tokens_p90"),
          tokens_p99: uintStr(r.tokens_p99, "tokens_p99"),
          tokens_p999: uintStr(r.tokens_p999, "tokens_p999"),
          gas_p50: uintStr(r.gas_p50, "gas_p50"),
          gas_p90: uintStr(r.gas_p90, "gas_p90"),
          gas_p99: uintStr(r.gas_p99, "gas_p99"),
          gas_p999: uintStr(r.gas_p999, "gas_p999"),
          percentile_method: "bigquery_approx_quantiles_1000",
        });
      } else {
        out.receivers.push({ ...base, receiver_account_id: text(r.account, "account") });
        const acc = recvSum.get(day) ?? {};
        for (const f of SUM_FIELDS) acc[f] = (acc[f] ?? 0n) + BigInt(sums[f] as string);
        recvSum.set(day, acc);
      }
    } else if (r.kind === "top_tx") {
      const n = (topCount.get(day) ?? 0) + 1;
      topCount.set(day, n);
      if (n > TOP_TX_PER_DAY) bad("too many top transactions for a day", "top_tx");
      out.topTx.push({
        block_date: day,
        rank: n,
        transaction_hash: text(r.tx_hash, "tx_hash"),
        signer_account_id: text(r.signer_id, "signer_id"),
        receiver_account_id: text(r.account, "account"),
        gas_burnt: uintStr(r.tx_gas, "tx_gas"),
        tokens_burnt_yocto: uintStr(r.tx_tokens_yocto, "tx_tokens_yocto"),
        receipts: uintStr(r.tx_receipts, "tx_receipts"),
        token_precision: "source_float64",
        ...prov(p),
      });
    } else bad("unknown row kind", "kind");
  }
  for (const d of out.days) {
    const acc = recvSum.get(d.block_date as string);
    if (!acc) bad("day without receiver rows", "receiver");
    for (const f of SUM_FIELDS)
      if ((acc as Record<string, bigint>)[f] !== BigInt(d[f] as string))
        bad(`per-receiver ${f} does not sum to the daily total`, f);
  }
  // top-tx rank order: tokens non-increasing per day
  const last = new Map<string, bigint>();
  for (const t of out.topTx) {
    const prev = last.get(t.block_date as string);
    const cur = BigInt(t.tokens_burnt_yocto as string);
    if (prev !== undefined && cur > prev) bad("top transactions are not ordered by tokens", "top_tx");
    last.set(t.block_date as string, cur);
  }
  return out;
}

export function gasPriceRows(rows: BqRow[], p: Provenance): Row[] {
  return rows.map((r) => {
    const blocks = big(r.blocks, "blocks");
    if (blocks === 0n) bad("day without blocks", "blocks");
    return {
      block_date: dayOf(r.block_date),
      blocks: blocks.toString(),
      min_gas_price_yocto: uintStr(r.min_gas_price, "min_gas_price"),
      max_gas_price_yocto: uintStr(r.max_gas_price, "max_gas_price"),
      sum_gas_price_yocto: uintStr(r.sum_gas_price, "sum_gas_price"),
      fractional_price_rows: uintStr(r.fractional_price_rows, "fractional_price_rows"),
      null_price_rows: uintStr(r.null_price_rows, "null_price_rows"),
      distinct_prices: uintStr(r.distinct_prices, "distinct_prices"),
      ...prov(p),
    };
  });
}

export { FOLDED_ACCOUNT };
