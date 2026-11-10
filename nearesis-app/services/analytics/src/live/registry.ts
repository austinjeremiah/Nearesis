import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricMetadata } from "@nearesis/contracts";
import { SERVICE_ROOT } from "../ch.ts";
import { Registry, type RegistryDimension } from "../registry/types.ts";
import { computeHash } from "../registry/registry.ts";
import { LIVE_CUBES } from "./definition.ts";

export const LIVE_REGISTRY_FILE = join(SERVICE_ROOT, "registry", "live", "metrics.live.v1.json");

const common = {
  segmentOverlap: "n/a" as const,
  botProxyDefinition: "Not filtered; includes bot and system traffic",
  denominator: "n/a: additive count or level with no denominator",
  certifiedVersion: "1.0.0",
  certified: true,
  owner: "nearesis-analytics",
  testFixture: "live:nearesis_live",
  visibility: "public" as const,
  zeroPolicy: "zero_requires_complete_coverage" as const,
};
const m = (
  id: string,
  member: string,
  p: Pick<
    MetricMetadata,
    "displayName" | "kind" | "unit" | "aggregationLaw" | "sources" | "transformations" | "uncertainty"
  > &
    Partial<MetricMetadata>,
): MetricMetadata => ({
  ...common,
  expectedUpdateLag: "PT24H",
  docUri: `docs/metrics/METRICS.md#${id.replace(".", "")}`,
  grain: "day",
  ...p,
  id,
  cubeMember: member,
});

export const LIVE_METRICS: MetricMetadata[] = [
  m("live.near_tx_count", "near_daily_tx_live.tx_count", {
    displayName: "LIVE daily transactions",
    kind: "flow",
    unit: "tx",
    aggregationLaw: "sum",
    sources: ["near-bigquery:near_daily_tx"],
    transformations: ["BigQuery crypto_near_mainnet_us.transactions, COUNT(*) by block_date"],
    uncertainty:
      "REAL data. Counts converted transactions, not successful ones (status only carries SUCCESS_RECEIPT_ID, FND-20261110-100). Bots included.",
  }),
  m("live.near_distinct_signer_proxy", "near_daily_tx_live.distinct_signer_proxy", {
    displayName: "LIVE daily distinct signer proxy",
    kind: "count",
    unit: "signers",
    aggregationLaw: "non_additive",
    segmentOverlap: "overlapping",
    botProxyDefinition: "Signer accounts are a proxy for activity, not unique humans",
    sources: ["near-bigquery:near_daily_tx"],
    transformations: ["BigQuery COUNT(DISTINCT signer_account_id) by block_date"],
    uncertainty: "REAL data. Not unique humans; daily values must never be summed into a period unique.",
  }),
  m("live.contract_interactions", "contract_interactions_live.interactions", {
    displayName: "LIVE function-call interactions (receivers >= 100/day)",
    kind: "flow",
    unit: "actions",
    aggregationLaw: "sum",
    sources: ["near-bigquery:contract_interactions"],
    transformations: [
      "BigQuery receipt_actions FUNCTION_CALL by block_date and receiver; receivers below 100 calls/day folded into a separate remainder table",
    ],
    uncertainty:
      "REAL data. Named receivers only (>= 100 calls that day); the remainder is not in this view. Contract project mapping is unverified (taxonomy uncategorized). Days before 2026-02-01 are pending (BigQuery quota) and are gaps, not zeros.",
  }),
  m("live.price_close_usd", "price_candles_live.close_price_usd", {
    displayName: "LIVE daily close price (USD, hourly-sampled)",
    kind: "stock",
    unit: "usd_price",
    aggregationLaw: "avg",
    botProxyDefinition: "n/a: not a per-actor metric, bot traffic is not separated",
    sources: ["coingecko:price_candles"],
    transformations: ["CoinGecko market_chart/range hourly samples; close = last of 24 samples (23:00 UTC)"],
    uncertainty:
      "REAL data. Not an exchange close: sampled hourly values (FND-20261110-101). Aggregator price; vintages can be revised.",
  }),
  m("live.oneclick_swap_count", "intents_swaps_live.swap_count", {
    displayName: "LIVE 1Click swaps (all statuses)",
    kind: "flow",
    unit: "swaps",
    aggregationLaw: "sum",
    expectedUpdateLag: "PT1H",
    sources: ["near-explorer:intents_swaps"],
    transformations: ["Explorer 1Click swaps deduplicated by swap key, latest status wins"],
    uncertainty:
      "REAL data, partner-reported. Backfill runs newest to oldest: days not yet reached are NOT covered (see coverage), never zero. Private-settlement era swaps (>= 2026-10-27) carry no public swap hash.",
  }),
  m("live.oneclick_completed_swap_count", "intents_swaps_live.completed_swap_count", {
    displayName: "LIVE 1Click completed swaps",
    kind: "flow",
    unit: "swaps",
    aggregationLaw: "sum",
    expectedUpdateLag: "PT1H",
    sources: ["near-explorer:intents_swaps"],
    transformations: ["Swaps with latest status SUCCESS"],
    uncertainty:
      "REAL data, partner-reported; status can change until final. See coverage for the loaded window.",
  }),
];

export function buildLiveRegistry(): Registry {
  const dimensions: RegistryDimension[] = [];
  for (const c of LIVE_CUBES) {
    dimensions.push({
      id: `${c.view}.day`,
      view: c.view,
      displayName: "Day (UTC)",
      kind: "time",
      visibility: "public",
    });
    for (const d of c.dimensions)
      dimensions.push({
        id: `${c.view}.${d.name}`,
        view: c.view,
        displayName: d.name.replaceAll("_", " "),
        kind: "dimension",
        visibility: "public",
      });
  }
  const base = {
    semanticVersion: "1.0.0",
    metrics: LIVE_METRICS,
    dimensions,
    evaluators: Object.fromEntries(LIVE_METRICS.map((x) => [x.id, null])),
    exactScales: {},
  };
  return { ...base, contentHash: computeHash(base) };
}

export function loadLiveRegistry(file = LIVE_REGISTRY_FILE): Registry {
  const r = Registry.parse(JSON.parse(readFileSync(file, "utf8")));
  if (computeHash(r) !== r.contentHash) throw new Error(`live registry hash mismatch in ${file}`);
  return r;
}
