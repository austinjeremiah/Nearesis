import { MetricProposal } from "@nearesis/contracts";

/**
 * Typed metric proposals for A19's governed authoring (final_master_prompt section 4/7). They are PROPOSALS ONLY: nothing here
 * edits the Cube model or the registry. They reference the A18 tables created by migrateEconomics() and need the catalogue
 * additions listed in COLUMN_UNITS_REQUEST (units: gas, yoctoNEAR, tx, block) before the compiler can validate them.
 * USD-denominated economics are intentionally absent: a USD value needs a timestamped price and an exposed conversion
 * method, which the typed proposal grammar cannot express; it stays in feeWithUsd().
 * No metric is named or described as protocol revenue.
 */
const col = (table: string, column: string) => ({ table, column });
const author = { principalId: "svc-a18-economics", kind: "service" as const, tenantId: "system" };
const T = "near_economics_tx_daily";
const P = "near_economics_gas_price_daily";

const base = {
  schemaVersion: 1 as const,
  namespace: "economics",
  joins: [],
  entityGrain: { kind: "global" as const },
  dimensions: [],
  filters: [],
  nullSemantics: { nullInput: "propagate" as const, emptyBucket: "null" as const },
  dedup: { strategy: "final" as const },
  historicalValidity: { validFrom: "2025-11-10", validTo: null, restatement: "may_restate" as const },
  costEstimate: { maxEstimatedRows: 5000 },
  dependencies: [],
  version: 1,
  author,
};
const limits = [
  "tokens_burnt is stored by the public dataset as FLOAT64: each source value carries relative error <= 2^-53; sums are exact on the stored values.",
  "Transaction-day basis: receipts executing after the lookahead window of the load are not attributed (see txs_without_receipt_rows).",
  "Refund NEAR amounts are not derived; refund-receipt gas is included in gas units but burns no tokens.",
  "An execution fee is not protocol revenue: the burn/contract-reward split depends on the protocol version.",
];

export const ECONOMICS_PROPOSALS = [
  {
    ...base,
    name: "execution_fee_yocto",
    displayName: "Execution fees (yoctoNEAR)",
    description:
      "Daily sum of the execution fees deducted for transactions and their receipts, in exact yoctoNEAR.",
    sources: [T],
    timeGrain: { column: col(T, "block_date"), grain: "day" as const },
    aggregations: [{ id: "fee", fn: "sum" as const, column: col(T, "total_tokens_yocto") }],
    unit: "yoctoNEAR",
    precision: { decimals: 0, rounding: "truncate" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw sum" },
      { kind: "non_negative" as const, name: "fees non-negative" },
    ],
    limitations: limits,
  },
  {
    ...base,
    name: "gas_units",
    displayName: "Gas units burnt",
    description:
      "Daily sum of gas units reported by transaction conversion and receipt outcomes (gas units, not tokens).",
    sources: [T],
    timeGrain: { column: col(T, "block_date"), grain: "day" as const },
    aggregations: [{ id: "gas", fn: "sum" as const, column: col(T, "total_gas") }],
    unit: "gas",
    precision: { decimals: 0, rounding: "truncate" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw sum" },
      { kind: "non_negative" as const, name: "gas non-negative" },
    ],
    limitations: limits,
  },
  {
    ...base,
    name: "gas_per_transaction",
    displayName: "Gas units per transaction (execution intensity)",
    description:
      "Average gas units per transaction: total gas divided by transaction count for the same day.",
    sources: [T],
    timeGrain: { column: col(T, "block_date"), grain: "day" as const },
    aggregations: [
      { id: "gas", fn: "sum" as const, column: col(T, "total_gas") },
      { id: "txs", fn: "sum" as const, column: col(T, "txs") },
    ],
    formula: {
      kind: "op" as const,
      op: "div" as const,
      left: { kind: "agg" as const, id: "gas" },
      right: { kind: "agg" as const, id: "txs" },
    },
    unit: "gas/tx",
    precision: { decimals: 3, rounding: "half_even" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw ratio" },
      { kind: "non_negative" as const, name: "non-negative" },
    ],
    limitations: limits,
  },
  {
    ...base,
    name: "fee_per_transaction_yocto",
    displayName: "Execution fee per transaction (yoctoNEAR)",
    description:
      "Average execution fee per transaction in yoctoNEAR: total fees divided by transaction count for the same day.",
    sources: [T],
    timeGrain: { column: col(T, "block_date"), grain: "day" as const },
    aggregations: [
      { id: "fee", fn: "sum" as const, column: col(T, "total_tokens_yocto") },
      { id: "txs", fn: "sum" as const, column: col(T, "txs") },
    ],
    formula: {
      kind: "op" as const,
      op: "div" as const,
      left: { kind: "agg" as const, id: "fee" },
      right: { kind: "agg" as const, id: "txs" },
    },
    unit: "yoctoNEAR/tx",
    precision: { decimals: 0, rounding: "half_even" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw ratio" },
      { kind: "non_negative" as const, name: "non-negative" },
    ],
    limitations: limits,
  },
  {
    ...base,
    name: "mean_gas_price_yocto_per_gas",
    displayName: "Mean block gas price (yoctoNEAR per gas)",
    description: "Daily mean of the block gas price: sum of block gas prices divided by block count.",
    sources: [P],
    timeGrain: { column: col(P, "block_date"), grain: "day" as const },
    aggregations: [
      { id: "price", fn: "sum" as const, column: col(P, "sum_gas_price_yocto") },
      { id: "blocks", fn: "sum" as const, column: col(P, "blocks") },
    ],
    formula: {
      kind: "op" as const,
      op: "div" as const,
      left: { kind: "agg" as const, id: "price" },
      right: { kind: "agg" as const, id: "blocks" },
    },
    unit: "yoctoNEAR/gas",
    precision: { decimals: 3, rounding: "half_even" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw ratio" },
      { kind: "min_rows" as const, name: "has days", rows: 1 },
    ],
    limitations: [
      "blocks.gas_price is the block's price field; the price at which an individual receipt's gas was bought or burnt can differ (see SEMANTICS.md).",
    ],
  },
].map((p) => MetricProposal.parse(p));

/** Catalogue additions A19 needs: AUTHORABLE_TABLES entries and COLUMN_UNITS (all other columns stay dimension/denied). */
export const AUTHORABLE_TABLES_REQUEST: Record<string, { provider: string; coverageDataset: string }> = {
  near_economics_tx_daily: { provider: "near-bigquery", coverageDataset: "near_economics_tx_daily" },
  near_economics_gas_price_daily: {
    provider: "near-bigquery",
    coverageDataset: "near_economics_gas_price_daily",
  },
};
export const COLUMN_UNITS_REQUEST: Record<string, string> = {
  "near_economics_tx_daily.txs": "tx",
  "near_economics_tx_daily.receipts": "receipt",
  "near_economics_tx_daily.total_gas": "gas",
  "near_economics_tx_daily.total_tokens_yocto": "yoctoNEAR",
  "near_economics_tx_daily.conversion_gas": "gas",
  "near_economics_tx_daily.conversion_tokens_yocto": "yoctoNEAR",
  "near_economics_tx_daily.receipt_gas": "gas",
  "near_economics_tx_daily.receipt_tokens_yocto": "yoctoNEAR",
  "near_economics_gas_price_daily.blocks": "1",
  "near_economics_gas_price_daily.sum_gas_price_yocto": "yoctoNEAR/gas",
};
