import type { MetricProposal } from "@nearesis/contracts";

/**
 * `intents.settled_volume_usd_known`: the SETTLED USD volume of 1Click swaps, proposed through the governed authoring path
 * (final_master_prompt section 4). It does NOT replace `live.oneclick_volume_usd_known`: that certified metric is defined as the
 * input USD volume over every status (a documented, pinned definition, so existing snapshots and monitors keep their meaning).
 * This is a separate metric with its own version history:
 *   - SUCCESS swaps only (REFUNDED, FAILED and PROCESSING input never counts as volume);
 *   - provider USD values above USD 1e9 are excluded by the USD_IMPLAUSIBLE rule (services/ingestion usd-quarantine.ts, which
 *     records every excluded swap as a quality gap, so nothing is dropped silently);
 *   - swaps with an unknown USD value are excluded and never valued at 0 (a day with none reads NULL).
 * It is a PROPOSAL: validate, then a human owner certifies (POST /v1/workspaces/:id/metrics/proposals, then .../certify).
 */
export const USD_IMPLAUSIBLE_THRESHOLD_USD = 1_000_000_000;

const T = "intents_swaps";
const col = (column: string) => ({ table: T, column });

export function settledVolumeProposal(author: MetricProposal["author"]): MetricProposal {
  return {
    schemaVersion: 1,
    namespace: "intents",
    name: "settled_volume_usd_known",
    displayName: "Settled 1Click volume (USD, known values only)",
    description:
      "Daily sum of the provider-stated input USD value of 1Click swaps whose latest status is SUCCESS. Swaps with an unknown USD value are excluded, never valued at zero. Provider values above USD 1e9 for one swap are quarantined as quality gaps and excluded.",
    sources: [T],
    joins: [],
    entityGrain: { kind: "global" },
    timeGrain: { column: col("created_day"), grain: "day" },
    dimensions: [],
    filters: [
      { column: col("status"), op: "eq", values: ["SUCCESS"] },
      { column: col("amount_in_usd"), op: "lte", values: [USD_IMPLAUSIBLE_THRESHOLD_USD] },
    ],
    aggregations: [{ id: "vol", fn: "sum", column: col("amount_in_usd") }],
    unit: "USD",
    precision: { decimals: 2, rounding: "half_even" },
    nullSemantics: { nullInput: "ignore", emptyBucket: "null" },
    dedup: { strategy: "final" },
    historicalValidity: { validFrom: "2025-11-10", validTo: null, restatement: "may_restate" },
    costEstimate: { maxEstimatedRows: 5000 },
    dependencies: [],
    tests: [
      { kind: "reconcile_raw", name: "equals raw sum over SUCCESS swaps within the plausibility bound" },
      { kind: "non_negative", name: "volume non-negative" },
    ],
    limitations: [
      "A LOWER BOUND: swaps with no provider USD value are excluded, not zero; read with the live USD completeness metric.",
      "USD values are provider-stated (partner-reported) at swap time; this metric does not re-price assets.",
      "USD_IMPLAUSIBLE: values above USD 1e9 per swap are excluded and recorded as quality gaps; threshold fixed by evidence in services/ingestion usd-quarantine.ts.",
      "Latest status wins; a swap can change status until final, so recent days may restate.",
    ],
    version: 1,
    author,
  };
}
