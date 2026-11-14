/**
 * Investment-thesis dashboard model, shared by the server routes and the client. Research results use R1's
 * `ResearchRunArtifact` and capsules use V1's `CapsuleViewRecord` (packages/contracts). Nothing here computes a
 * statistic: statistics are only ever displayed from published artifacts.
 */
import { z } from "zod";
import type { CapsuleResponseRecord, CapsuleViewRecord, ResearchRunArtifact } from "@nearesis/contracts";

/** The five epistemic classes the dashboard must keep visually distinct (final_prompt §9). */
export const CLAIM_CLASSES = ["observed", "derived", "interpretation", "hypothesis", "unsupported"] as const;
export type ClaimClass = (typeof CLAIM_CLASSES)[number];
export const CLAIM_LABEL: Record<ClaimClass, string> = {
  observed: "Observed fact",
  derived: "Derived statistic",
  interpretation: "Agent interpretation",
  hypothesis: "Hypothesis",
  unsupported: "Unsupported or unknown",
};

/**
 * Server-side whitelist of certified metrics on the thesis page. The client can only pick keys and a date window; the
 * AST is built on the server and every query goes through the guarded semantic gateway.
 */
export interface ThesisSeriesDef {
  key: string;
  /** Certified metric id (the gateway resolves measures by metric id). */
  member: string;
  timeField: string;
  group: "intents" | "adoption" | "price";
  label: string;
  definition: string;
  limitation: string;
  /** Member mapping on the LIVE real-data layer (its own certified registry). */
  live: { member: string; timeField: string; definition?: string; limitation?: string };
}
export const THESIS_SERIES: readonly ThesisSeriesDef[] = [
  {
    key: "swaps",
    member: "intents.oneclick_completed_swap_count",
    timeField: "intents.day",
    group: "intents",
    label: "Completed 1Click swaps",
    definition: "Explorer-reported 1Click swaps with status SUCCESS, by UTC creation day.",
    limitation:
      "Explorer covers 1Click only, not all Intents activity; private-settlement swaps (from 2026-10-27) are partner-reported.",
    live: { member: "live.oneclick_completed_swap_count", timeField: "intents_swaps_live.day" },
  },
  {
    key: "volume",
    member: "intents.oneclick_volume_usd",
    timeField: "intents.day",
    group: "intents",
    label: "1Click volume (USD)",
    definition: "Sum of provider-reported amountInUsd for completed 1Click swaps, by UTC day.",
    limitation:
      "USD values are the provider's conversion at swap time; in-flight swaps report 0 and are excluded.",
    live: {
      member: "live.oneclick_volume_usd_known",
      timeField: "intents_swaps_live.day",
      definition:
        "Sum of provider-reported amountInUsd for completed 1Click swaps whose USD value is known, by UTC day.",
      limitation:
        "Swaps with an unknown USD value are excluded, not counted as zero; see the USD-completeness ratio on the live layer. Explorer covers 1Click only.",
    },
  },
  {
    key: "tx",
    member: "near.daily_successful_tx_count",
    timeField: "near_usage.day",
    group: "adoption",
    label: "Successful NEAR transactions",
    definition: "Confirmed successful transactions per UTC block_date from the NEAR BigQuery public dataset.",
    limitation:
      "Transaction counts include bots and protocol activity; they are an adoption proxy, not users.",
    live: { member: "live.near_tx_count", timeField: "near_daily_tx_live.day" },
  },
  {
    key: "signers",
    member: "near.distinct_signer_proxy",
    timeField: "near_usage.day",
    group: "adoption",
    label: "Daily distinct signers (proxy)",
    definition: "Distinct signer accounts per UTC day. Not unique humans; never summed across days.",
    limitation:
      "Signer accounts are a proxy: one person can control many accounts and many accounts are automated.",
    live: { member: "live.near_distinct_signer_proxy", timeField: "near_daily_tx_live.day" },
  },
  {
    key: "price",
    member: "prices.daily_close_price_usd",
    timeField: "prices.day",
    group: "price",
    label: "NEAR close price (USD)",
    definition: "CoinGecko daily close for NEAR/USD, by UTC day; missing days stay gaps.",
    limitation: "A single market aggregator; prices are not volume-weighted across venues.",
    live: { member: "live.price_close_usd", timeField: "price_candles_live.day" },
  },
];

export const ThesisWindow = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
});

/** One observed series as served to the client (rows are [ISO day, value|null]). */
export interface ThesisSeries {
  key: string;
  label: string;
  member: string;
  unit: string | null;
  rows: Array<[string, number | null]>;
  coverage: { expectedDays: number; observedDays: number; missingDays: number; partialDays: number };
  gaps: Array<{ from: string; to: string; reason: string }>;
  provenance: {
    queryHash: string;
    semanticVersion: string;
    semanticModelHash: string;
    sourceSnapshotId: string | null;
    certification: string;
    sources: string[];
    watermark: string | null;
    ast: unknown;
    resultHash: string;
  };
  definition: string;
  limitation: string;
  error: { status: number; code: string; message: string } | null;
}

export interface ThesisData {
  window: { from: string; to: string };
  sourceLabel: "SYNTHETIC" | "RECORDED" | "LIVE";
  dataSource: "fixture" | "live";
  series: ThesisSeries[];
  watermarks: Record<string, { state: string; newestEventTime: string | null }>;
  generatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Research results (R1's ResearchRunArtifact) and capsules (V1's CapsuleViewRecord) come from published contracts.

export type CapsuleView = CapsuleViewRecord;
export type CapsuleResponse = CapsuleResponseRecord;

export type ArtifactsResponse =
  | {
      status: "available";
      /** Capsule the run was read from, and the SHA-256 the capsule manifest records for the run file. */
      capsuleId: string;
      runFileSha256: string | null;
      artifact: ResearchRunArtifact;
    }
  | { status: "unavailable"; reason: string };

/**
 * Display status for verification. OutLayer-backed proof is shown as verified only with status "verified" AND a job
 * id AND a check time; anything else is unverified. Local reproducibility is never shown as cryptographic proof.
 */
export function proofStatus(v: CapsuleView["verification"]): {
  local: "reproduced" | "mismatch" | "not_run";
  outlayer: "verified" | "failed" | "unverified";
  outlayerNote: string | null;
} {
  const o = v.outlayer;
  let outlayer: "verified" | "failed" | "unverified" = "unverified";
  let outlayerNote: string | null = null;
  if (o.status === "verified" && o.jobId && o.checkedAt) outlayer = "verified";
  else if (o.status === "verified")
    outlayerNote = "Record claims verified but lacks a job id or check time; treated as unverified.";
  else if (o.status === "failed") outlayer = "failed";
  else if (o.status === "not_submitted")
    outlayerNote = "No OutLayer job has been submitted for this capsule.";
  return { local: v.local.status, outlayer, outlayerNote };
}
