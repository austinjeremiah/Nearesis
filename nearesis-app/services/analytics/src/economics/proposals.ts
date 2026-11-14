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
const author = { principalId: "svc-a24-economics", kind: "service" as const, tenantId: "system" };
const O = "near_economics_outcomes_daily";
const V = "near_economics_conversion_daily";
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
  "Execution-day basis (lean load, rule version 2): the day an outcome executed, from execution_outcomes alone. Whether that table includes the transaction outcomes is verified on the pilot reference day, not assumed.",
  "Refund NEAR amounts are not derived; the refund split is the ZERO_TOKEN proxy (tokens_burnt = 0), validated on a reference day; refund-receipt gas is included in gas units but burns no tokens.",
  "An execution fee is not protocol revenue: the burn/contract-reward split depends on the protocol version.",
];

export const ECONOMICS_PROPOSALS = [
  {
    ...base,
    name: "execution_fee_yocto",
    displayName: "Execution fees (yoctoNEAR)",
    description:
      "Daily sum of tokens_burnt over all execution outcomes (transactions and receipts) executed that day, in exact yoctoNEAR.",
    sources: [O],
    timeGrain: { column: col(O, "block_date"), grain: "day" as const },
    aggregations: [{ id: "fee", fn: "sum" as const, column: col(O, "tokens_burnt_yocto") }],
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
      "Daily sum of gas_burnt over all execution outcomes executed that day (gas units, not tokens; includes refund-receipt executions).",
    sources: [O],
    timeGrain: { column: col(O, "block_date"), grain: "day" as const },
    aggregations: [{ id: "gas", fn: "sum" as const, column: col(O, "gas_burnt") }],
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
    name: "gas_per_execution_outcome",
    displayName: "Gas units per execution outcome",
    description:
      "Average gas units per execution outcome (transaction or receipt) executed that day: total gas divided by outcome count. Not gas per transaction.",
    sources: [O],
    timeGrain: { column: col(O, "block_date"), grain: "day" as const },
    aggregations: [
      { id: "gas", fn: "sum" as const, column: col(O, "gas_burnt") },
      { id: "n", fn: "sum" as const, column: col(O, "outcomes") },
    ],
    formula: {
      kind: "op" as const,
      op: "div" as const,
      left: { kind: "agg" as const, id: "gas" },
      right: { kind: "agg" as const, id: "n" },
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
    name: "fee_per_execution_outcome_yocto",
    displayName: "Execution fee per execution outcome (yoctoNEAR)",
    description:
      "Average execution fee per execution outcome executed that day: total fees divided by outcome count (zero-fee refund executions are in the denominator).",
    sources: [O],
    timeGrain: { column: col(O, "block_date"), grain: "day" as const },
    aggregations: [
      { id: "fee", fn: "sum" as const, column: col(O, "tokens_burnt_yocto") },
      { id: "n", fn: "sum" as const, column: col(O, "outcomes") },
    ],
    formula: {
      kind: "op" as const,
      op: "div" as const,
      left: { kind: "agg" as const, id: "fee" },
      right: { kind: "agg" as const, id: "n" },
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
    name: "transactions",
    displayName: "Transactions (signed that day)",
    description: "Daily transaction count from the transactions table (transaction-day basis).",
    sources: [V],
    timeGrain: { column: col(V, "block_date"), grain: "day" as const },
    filters: [{ column: col(V, "scope"), op: "eq" as const, values: ["day"] }],
    aggregations: [{ id: "txs", fn: "sum" as const, column: col(V, "txs") }],
    unit: "tx",
    precision: { decimals: 0, rounding: "truncate" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw sum" },
      { kind: "non_negative" as const, name: "non-negative" },
    ],
    limitations: limits,
  },
  {
    ...base,
    name: "transaction_conversion_fee_yocto",
    displayName: "Transaction-to-receipt conversion fee (yoctoNEAR)",
    description:
      "Daily sum of receipt_conversion_tokens_burnt over transactions signed that day: the fee of converting a transaction into its first receipt, not the full transaction cost.",
    sources: [V],
    timeGrain: { column: col(V, "block_date"), grain: "day" as const },
    filters: [{ column: col(V, "scope"), op: "eq" as const, values: ["day"] }],
    aggregations: [{ id: "fee", fn: "sum" as const, column: col(V, "conversion_tokens_yocto") }],
    unit: "yoctoNEAR",
    precision: { decimals: 0, rounding: "truncate" as const },
    tests: [
      { kind: "reconcile_raw" as const, name: "equals raw sum" },
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
  near_economics_outcomes_daily: {
    provider: "near-bigquery",
    coverageDataset: "near_economics_outcomes_daily",
  },
  near_economics_conversion_daily: {
    provider: "near-bigquery",
    coverageDataset: "near_economics_conversion_daily",
  },
  near_economics_gas_price_daily: {
    provider: "near-bigquery",
    coverageDataset: "near_economics_gas_price_daily",
  },
};
export const COLUMN_UNITS_REQUEST: Record<string, string> = {
  "near_economics_outcomes_daily.outcomes": "tx",
  "near_economics_outcomes_daily.gas_burnt": "gas",
  "near_economics_outcomes_daily.tokens_burnt_yocto": "yoctoNEAR",
  "near_economics_conversion_daily.txs": "tx",
  "near_economics_conversion_daily.conversion_gas": "gas",
  "near_economics_conversion_daily.conversion_tokens_yocto": "yoctoNEAR",
  "near_economics_gas_price_daily.blocks": "1",
  "near_economics_gas_price_daily.sum_gas_price_yocto": "yoctoNEAR/gas",
};
