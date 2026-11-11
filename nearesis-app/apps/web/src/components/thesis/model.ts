/**
 * Investment-thesis dashboard model. Shared by the server routes (validation) and the client (rendering).
 *
 * Research artifacts and capsules have no published contract yet (`packages/contracts/src/research-artifacts.ts` is an
 * empty seam). These local schemas are the bound interface until R1/Engine A publish theirs; a queue request asks for
 * the contract. Nothing here computes a statistic: statistics are only ever displayed from artifacts.
 */
import { z } from "zod";

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
// Research artifacts (bound interface until the contract lands)

const Id = z.string().min(1).max(120);
export const ResearchArtifacts = z.strictObject({
  artifactSetId: Id,
  producer: z.string().min(1).max(200),
  producedAt: z.iso.datetime({ offset: true }),
  sourceLabel: z.enum(["SYNTHETIC", "RECORDED", "LIVE"]),
  question: z.string().min(1).max(500),
  hypothesis: z.strictObject({
    id: Id,
    statement: z.string().min(1).max(1000),
    preregistrationHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    preregisteredAt: z.iso.datetime({ offset: true }).nullable(),
    falsification: z
      .array(
        z.strictObject({
          id: Id,
          criterion: z.string().min(1).max(500),
          status: z.enum(["not_triggered", "triggered", "not_evaluated"]),
          resultId: Id.nullable(),
        }),
      )
      .max(20),
  }),
  verdict: z
    .strictObject({
      status: z.enum(["SUPPORTED", "NOT_SUPPORTED", "MIXED", "INSUFFICIENT_DATA"]),
      summary: z.string().max(1000),
      resultIds: z.array(Id).max(50),
    })
    .nullable(),
  lagResults: z
    .array(
      z.strictObject({
        id: Id,
        leader: z.string().max(120),
        follower: z.string().max(120),
        lagDays: z.number().int().min(-120).max(120),
        estimate: z.number(),
        ciLow: z.number().nullable(),
        ciHigh: z.number().nullable(),
        pValue: z.number().min(0).max(1).nullable(),
        n: z.number().int().nonnegative(),
        method: z.string().max(200),
      }),
    )
    .max(400),
  models: z
    .array(
      z.strictObject({
        id: Id,
        name: z.string().max(200),
        target: z.string().max(120),
        features: z.array(z.string().max(120)).max(20),
        holdout: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
        metric: z.enum(["MAE", "RMSE", "MAPE", "R2"]),
        value: z.number().nullable(),
        baseline: z.boolean(),
        n: z.number().int().nonnegative(),
      }),
    )
    .max(50),
  evidence: z
    .array(
      z.strictObject({
        id: Id,
        side: z.enum(["bull", "bear"]),
        claimClass: z.enum(CLAIM_CLASSES),
        text: z.string().min(1).max(1000),
        resultIds: z.array(Id).max(20),
        graphNodeId: Id.nullable(),
      }),
    )
    .max(20),
  limitations: z.array(z.string().max(500)).max(30),
  capsuleId: Id.nullable(),
});
export type ResearchArtifacts = z.infer<typeof ResearchArtifacts>;

export type ArtifactsResponse =
  { status: "available"; artifacts: ResearchArtifacts } | { status: "unavailable"; reason: string };

// ---------------------------------------------------------------------------------------------------------------
// Research capsule (presentation only; verification is performed by Engine A, never in the browser)

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
export const CapsuleView = z.strictObject({
  capsuleId: Id,
  title: z.string().min(1).max(300),
  sourceLabel: z.enum(["SYNTHETIC", "RECORDED", "LIVE"]),
  createdAt: z.iso.datetime({ offset: true }),
  claims: z
    .array(
      z.strictObject({
        id: Id,
        text: z.string().max(1000),
        claimClass: z.enum(CLAIM_CLASSES),
        resultIds: z.array(Id).max(20),
      }),
    )
    .max(50),
  results: z
    .array(
      z.strictObject({
        id: Id,
        label: z.string().max(200),
        value: z.string().max(80),
        unit: z.string().max(40).nullable(),
        computation: z.string().max(300),
      }),
    )
    .max(100),
  hashes: z.strictObject({
    preregistrationHash: Sha.nullable(),
    sourceSnapshotHash: Sha,
    semanticModelHash: Sha,
    analysisCodeCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
    containerDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable(),
    resultManifestHash: Sha,
  }),
  verification: z.strictObject({
    local: z.strictObject({
      status: z.enum(["reproduced", "mismatch", "not_run"]),
      method: z.string().max(300),
      checkedAt: z.iso.datetime({ offset: true }).nullable(),
      detail: z.string().max(500),
    }),
    outlayer: z.strictObject({
      status: z.enum(["verified", "failed", "unverified", "not_submitted"]),
      method: z.string().max(300),
      jobId: z.string().max(200).nullable(),
      checkedAt: z.iso.datetime({ offset: true }).nullable(),
      detail: z.string().max(500),
    }),
    failures: z
      .array(
        z.strictObject({
          at: z.iso.datetime({ offset: true }),
          kind: z.string().max(80),
          detail: z.string().max(500),
        }),
      )
      .max(50),
  }),
  provenance: z
    .array(
      z.strictObject({
        id: Id,
        kind: z.enum(["source", "snapshot", "query", "model", "result", "claim", "code"]),
        label: z.string().max(300),
        hash: z.string().max(80).nullable(),
        parents: z.array(Id).max(20),
      }),
    )
    .max(200),
  rebuild: z.strictObject({
    command: z.string().max(300),
    snapshotId: z.string().max(120),
    steps: z.array(z.string().max(300)).max(20),
  }),
  exports: z
    .array(z.strictObject({ label: z.string().max(120), href: z.string().max(500), sha256: Sha.nullable() }))
    .max(20),
  limitations: z.array(z.string().max(500)).max(30),
});
export type CapsuleView = z.infer<typeof CapsuleView>;

export type CapsuleResponse =
  { status: "available"; capsule: CapsuleView } | { status: "unavailable"; reason: string };

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
