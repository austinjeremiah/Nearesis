import {
  EconomicsUnitError,
  gasToYocto,
  mkGas,
  mkYocto,
  parseGas,
  parseYocto,
  plain,
  ratio,
  sumGas,
  sumYocto,
  yoctoToNear,
  yoctoToUsd,
  type Gas,
  type PriceSource,
  type UsdValue,
  type Yocto,
} from "./units.ts";

/**
 * Metric computations over loaded `near_economics_*` rows (exact BigInt; strings in and out).
 *
 * Naming is deliberate (SEMANTICS.md): `execution_fee` is what the runtime deducted for execution (the source's
 * `tokens_burnt`, gross). `burnt` and `contract_reward` are a MODELLED split that depends on the protocol regime and is
 * never called protocol revenue. There is no protocol-revenue metric.
 */
export const FOLDED = "__below_threshold__";

export type FeeRegime =
  | { id: "contract_reward_30pct"; contractRewardPercent: 30 } // protocol versions < 87 (documented)
  | { id: "all_burnt"; contractRewardPercent: 0 }; // protocol version >= 87 (documented; mainnet activation unverified)

export const REGIME_PRE_V87: FeeRegime = { id: "contract_reward_30pct", contractRewardPercent: 30 };
export const REGIME_V87: FeeRegime = { id: "all_burnt", contractRewardPercent: 0 };

export interface FeeSplit {
  executionFee: Yocto;
  contractReward: Yocto;
  burnt: Yocto;
  regime: FeeRegime["id"];
  basis: "modelled_from_documented_regime";
}

/** reward = floor(fee x pct / 100) (integer arithmetic, as the runtime uses); burnt = fee - reward. Parts always sum to the fee. */
export function splitFee(fee: Yocto, regime: FeeRegime): FeeSplit {
  const reward = (fee.units * BigInt(regime.contractRewardPercent)) / 100n;
  return {
    executionFee: fee,
    contractReward: mkYocto(reward),
    burnt: mkYocto(fee.units - reward),
    regime: regime.id,
    basis: "modelled_from_documented_regime",
  };
}

export interface OutcomeRow {
  block_date: string;
  executor_account_id: string;
  outcome_kind: string;
  status_class: string;
  outcomes: string;
  gas_burnt: string;
  tokens_burnt_yocto: string;
}
export interface TxDayRow {
  block_date: string;
  txs: string;
  receipts: string;
  total_gas: string;
  total_tokens_yocto: string;
  conversion_gas: string;
  conversion_tokens_yocto: string;
  receipt_gas: string;
  receipt_tokens_yocto: string;
  tokens_p50?: string;
  tokens_p90?: string;
  tokens_p99?: string;
  tokens_p999?: string;
  gas_p50?: string;
  gas_p90?: string;
  gas_p99?: string;
  percentile_method?: string;
}
export interface TxReceiverRow {
  block_date: string;
  receiver_account_id: string;
  txs: string;
  receipts: string;
  total_gas: string;
  total_tokens_yocto: string;
}
export interface TopTxRow {
  block_date: string;
  rank: number;
  transaction_hash: string;
  receiver_account_id: string;
  gas_burnt: string;
  tokens_burnt_yocto: string;
}

export interface DailyFee {
  day: string;
  /** Receipt/transaction outcomes EXECUTED that day (execution-day basis). */
  gasUnits: string;
  executionFeeYocto: string;
  executionFeeNear: string;
  /** Gas of REFUND receipts is reported by the runtime but burns no tokens: split out so units never mix. */
  refundReceiptGasUnits: string;
  /** Gas of zero-token executions (lean load, rule v2): a PROXY for refunds (also any other zero-fee execution). */
  zeroTokenGasUnits: string;
  outcomes: string;
}

/** Daily totals on the execution-day basis from near_economics_outcomes_daily rows (all kinds, exact). */
export function dailyFeeTotals(rows: OutcomeRow[]): DailyFee[] {
  const by = new Map<string, { g: Gas[]; t: Yocto[]; rg: Gas[]; zg: Gas[]; n: bigint }>();
  for (const r of rows) {
    const a = by.get(r.block_date) ?? { g: [], t: [], rg: [], zg: [], n: 0n };
    a.g.push(parseGas(r.gas_burnt));
    a.t.push(parseYocto(r.tokens_burnt_yocto));
    if (r.outcome_kind === "REFUND") a.rg.push(parseGas(r.gas_burnt));
    if (r.outcome_kind === "ZERO_TOKEN") a.zg.push(parseGas(r.gas_burnt));
    a.n += BigInt(r.outcomes);
    by.set(r.block_date, a);
  }
  return [...by]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, a]) => {
      const fee = sumYocto(a.t);
      return {
        day,
        gasUnits: sumGas(a.g).units.toString(),
        executionFeeYocto: fee.units.toString(),
        executionFeeNear: yoctoToNear(fee),
        refundReceiptGasUnits: sumGas(a.rg).units.toString(),
        zeroTokenGasUnits: sumGas(a.zg).units.toString(),
        outcomes: a.n.toString(),
      };
    });
}

export interface ContractGas {
  account: string;
  folded: boolean;
  gasUnits: string;
  executionFeeYocto: string;
  /** Share of the day's fee in basis points (integer, half-even), null when the day total is zero. */
  feeShareBps: string | null;
}

/**
 * Gas/fee by executing account for one day, optionally mapped to an application through `appOf` (A17's registry resolver);
 * unmapped accounts stay under their own account id (never invented). Per-account sums always equal the day total.
 */
export function gasByContract(
  rows: OutcomeRow[],
  day: string,
  appOf?: (account: string, day: string) => string | null,
): { items: ContractGas[]; totalGas: string; totalFeeYocto: string } {
  const acc = new Map<string, { g: bigint; t: bigint; folded: boolean }>();
  let tg = 0n;
  let tt = 0n;
  for (const r of rows) {
    if (r.block_date !== day) continue;
    const g = parseGas(r.gas_burnt).units;
    const t = parseYocto(r.tokens_burnt_yocto).units;
    const key =
      r.executor_account_id === FOLDED
        ? FOLDED
        : (appOf?.(r.executor_account_id, day) ?? r.executor_account_id);
    const a = acc.get(key) ?? { g: 0n, t: 0n, folded: key === FOLDED };
    a.g += g;
    a.t += t;
    acc.set(key, a);
    tg += g;
    tt += t;
  }
  const items = [...acc]
    .map(([account, a]) => ({
      account,
      folded: a.folded,
      gasUnits: a.g.toString(),
      executionFeeYocto: a.t.toString(),
      feeShareBps: tt === 0n ? null : ratio(a.t * 10_000n, tt, 0),
      _t: a.t,
    }))
    .sort((x, y) => (x._t === y._t ? (x.account < y.account ? -1 : 1) : x._t > y._t ? -1 : 1))
    .map(({ _t, ...rest }) => rest);
  return { items, totalGas: tg.toString(), totalFeeYocto: tt.toString() };
}

/** Herfindahl-Hirschman index over per-account fee shares (0..10000, integer), excluding the folded remainder. */
export function feeConcentrationHhi(items: ContractGas[], totalFeeYocto: string): string | null {
  const tt = BigInt(totalFeeYocto);
  if (tt === 0n) return null;
  let s = 0n;
  for (const i of items) {
    if (i.folded) continue;
    const sh = BigInt(i.executionFeeYocto);
    s += (sh * 10_000n * sh * 10_000n) / (tt * tt) / 10_000n;
  }
  return s.toString();
}

/** Execution intensity: gas units per transaction and fee (yocto) per transaction, exact decimals; null when no transactions. */
export function executionIntensity(
  d: Pick<TxDayRow, "txs" | "total_gas" | "total_tokens_yocto" | "receipts">,
): { gasPerTx: string | null; feeYoctoPerTx: string | null; receiptsPerTx: string | null } {
  const n = BigInt(d.txs);
  return {
    gasPerTx: ratio(BigInt(d.total_gas), n, 3),
    feeYoctoPerTx: ratio(BigInt(d.total_tokens_yocto), n, 0),
    receiptsPerTx: ratio(BigInt(d.receipts), n, 4),
  };
}

export interface CostPercentiles {
  method: string;
  exact: false;
  p50: string;
  p90: string;
  p99: string;
  p999: string;
}
/** Percentiles of per-transaction execution fee (yoctoNEAR), labelled approximate: the source query uses APPROX_QUANTILES. */
export function feePercentiles(d: TxDayRow): CostPercentiles | null {
  if (
    d.tokens_p50 === undefined ||
    d.tokens_p90 === undefined ||
    d.tokens_p99 === undefined ||
    d.tokens_p999 === undefined
  )
    return null;
  return {
    method: d.percentile_method ?? "bigquery_approx_quantiles_1000",
    exact: false,
    p50: d.tokens_p50,
    p90: d.tokens_p90,
    p99: d.tokens_p99,
    p999: d.tokens_p999,
  };
}

/** High-cost transactions: top rows whose fee is at least `thresholdYocto`; keeps the source rank order. */
export function highCostTransactions(rows: TopTxRow[], day: string, thresholdYocto: string): TopTxRow[] {
  const thr = parseYocto(thresholdYocto).units;
  return rows
    .filter((r) => r.block_date === day && BigInt(r.tokens_burnt_yocto) >= thr)
    .sort((a, b) => a.rank - b.rank);
}

/** Activity versus cost: transactions per NEAR of fee (6 fractional digits), same-day basis. */
export function activityPerNear(txs: string, feeYocto: string): string | null {
  const fee = BigInt(feeYocto);
  if (fee === 0n) return null;
  return ratio(BigInt(txs) * 10n ** 24n, fee, 6);
}

export interface Reconciliation {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

/** Invariant: per-receiver rows (named + folded) sum to the day's totals for every additive column. */
export function reconcileReceiversToDay(day: TxDayRow, receivers: TxReceiverRow[]): Reconciliation[] {
  const mine = receivers.filter((r) => r.block_date === day.block_date);
  const cols = ["txs", "receipts", "total_gas", "total_tokens_yocto"] as const;
  return cols.map((c) => {
    const actual = mine.reduce((a, r) => a + BigInt(r[c]), 0n);
    return {
      name: `receivers_sum_${c}`,
      ok: actual === BigInt(day[c]),
      expected: day[c],
      actual: actual.toString(),
    };
  });
}

/** Invariant: total = conversion + receipt parts, for gas and for tokens, each in its own unit. */
export function reconcileTxParts(day: TxDayRow): Reconciliation[] {
  const g = BigInt(day.conversion_gas) + BigInt(day.receipt_gas);
  const t = BigInt(day.conversion_tokens_yocto) + BigInt(day.receipt_tokens_yocto);
  return [
    { name: "gas_parts", ok: g === BigInt(day.total_gas), expected: day.total_gas, actual: g.toString() },
    {
      name: "tokens_parts",
      ok: t === BigInt(day.total_tokens_yocto),
      expected: day.total_tokens_yocto,
      actual: t.toString(),
    },
  ];
}

/**
 * Cross-family check (execution-day vs transaction-day basis): the NO_RECEIPT_ROW outcomes of a day are the transaction
 * outcomes (or receipts outside the join window); their tokens should equal the transactions table's conversion burn. The
 * result is REPORTED, never forced: a difference is a quality finding, not an error to hide.
 */
export function reconcileOutcomesToTransactions(outcomes: OutcomeRow[], day: TxDayRow): Reconciliation {
  const t = outcomes
    .filter((r) => r.block_date === day.block_date && r.outcome_kind === "NO_RECEIPT_ROW")
    .reduce((a, r) => a + BigInt(r.tokens_burnt_yocto), 0n);
  return {
    name: "no_receipt_row_tokens_vs_conversion_tokens",
    ok: t === BigInt(day.conversion_tokens_yocto),
    expected: day.conversion_tokens_yocto,
    actual: t.toString(),
  };
}

/** Effective burn price (yocto per gas unit) of a set of outcomes; null when no gas. Refund rows must be excluded by the caller. */
export function effectivePriceYoctoPerGas(feeYocto: string, gasUnits: string): string | null {
  return ratio(BigInt(feeYocto), BigInt(gasUnits), 3);
}

/** What a gas amount would cost at a flat price (explicit bridge between units; the price is an input, never assumed). */
export function gasAtPrice(g: string, yoctoPerGas: string): string {
  return gasToYocto(parseGas(g), BigInt(yoctoPerGas)).units.toString();
}

export interface FeeWithUsd {
  executionFeeYocto: string;
  executionFeeNear: string;
  usd: UsdValue | null;
  usdUnavailableReason: string | null;
}
/** USD only with a timestamped price whose method is exposed; otherwise null with a reason (never a silent 0). */
export function feeWithUsd(feeYocto: string, price: PriceSource | null): FeeWithUsd {
  const y = parseYocto(feeYocto);
  if (!price)
    return {
      executionFeeYocto: feeYocto,
      executionFeeNear: yoctoToNear(y),
      usd: null,
      usdUnavailableReason: "NO_TIMESTAMPED_PRICE",
    };
  return {
    executionFeeYocto: feeYocto,
    executionFeeNear: yoctoToNear(y),
    usd: yoctoToUsd(y, price),
    usdUnavailableReason: null,
  };
}

export { EconomicsUnitError, mkGas, plain };

/**
 * Lean reconciliation (rule v2): execution-day outcomes must contain at least the transaction-day conversion burn (the
 * transaction outcomes are in execution_outcomes). The difference is the implied receipt-only burn. REPORTED, never forced:
 * the two bases differ at day edges by construction, so this is a bound check, not an equality.
 */
export function reconcileOutcomesContainConversion(
  outcomes: OutcomeRow[],
  conversion: { block_date: string; conversion_gas: string; conversion_tokens_yocto: string },
): Reconciliation[] {
  const rows = outcomes.filter((r) => r.block_date === conversion.block_date);
  const gas = rows.reduce((a, r) => a + BigInt(r.gas_burnt), 0n);
  const tok = rows.reduce((a, r) => a + BigInt(r.tokens_burnt_yocto), 0n);
  return [
    {
      name: "outcome_gas_at_least_conversion_gas",
      ok: gas >= BigInt(conversion.conversion_gas),
      expected: `>= ${conversion.conversion_gas}`,
      actual: gas.toString(),
    },
    {
      name: "outcome_tokens_at_least_conversion_tokens",
      ok: tok >= BigInt(conversion.conversion_tokens_yocto),
      expected: `>= ${conversion.conversion_tokens_yocto}`,
      actual: tok.toString(),
    },
  ];
}
