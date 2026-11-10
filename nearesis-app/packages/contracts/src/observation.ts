import { z } from "zod";
import { DecimalString, IsoDateTime, Sha256Hex, SourceMode } from "./common.ts";

/** ch.07 canonical raw envelope (matches Bible schemas/raw_observation.schema.json intent). */
export const RawObservation = z.strictObject({
  providerId: z.enum([
    "near-bigquery",
    "near-explorer",
    "intents-1click",
    "coingecko",
    "near-contract-registry",
  ]),
  adapterVersion: z.string().min(1),
  requestFingerprint: Sha256Hex,
  sourceURL: z.string().url(),
  sourceEnvironment: SourceMode,
  fetchedAtUTC: IsoDateTime,
  providerEventAtUTC: IsoDateTime.nullable(),
  providerEventAtNullReason: z.string().max(200).optional(),
  receivedAtUTC: IsoDateTime,
  responseStatus: z.number().int().min(0).max(599),
  contentType: z.string().max(200),
  payloadObjectHash: Sha256Hex,
  normalizedHash: Sha256Hex.optional(),
  cursorBefore: z.string().max(2000).optional(),
  cursorAfter: z.string().max(2000).optional(),
  sourceSchemaVersion: z.string().max(100).optional(),
  recordsClaimed: z.number().int().nonnegative().optional(),
  recordsParsed: z.number().int().nonnegative().optional(),
  rateLimitHeaders: z.record(z.string(), z.string()).optional(),
  privacyVisibility: z.enum(["public", "partner_reported", "private_hidden"]),
  completeness: z.enum(["complete", "partial", "unknown"]),
  warnings: z.array(z.string().max(500)).max(100),
});
export type RawObservation = z.infer<typeof RawObservation>;

/** Effective-dated asset identifier mapping (D08: Nov 9 token ID migration). */
export const AssetAlias = z.strictObject({
  canonicalAssetId: z.string().min(1),
  providerAssetId: z.string().min(1),
  providerId: z.string().min(1),
  validFrom: IsoDateTime,
  validTo: IsoDateTime.nullable(),
  evidenceUrl: z.string().url().nullable(),
  verification: z.enum(["verified", "unverified", "ambiguous"]),
});
export type AssetAlias = z.infer<typeof AssetAlias>;

export const ContractRegistryEntry = z.strictObject({
  chain: z.string().min(1),
  accountId: z.string().min(1),
  project: z.string().min(1),
  taxonomy: z.string().min(1),
  validFrom: IsoDateTime,
  validTo: IsoDateTime.nullable(),
  ownershipVerification: z.enum(["verified", "unverified", "ambiguous"]),
  evidenceUrl: z.string().url().nullable(),
  ambiguityScore: z.number().min(0).max(1),
});
export type ContractRegistryEntry = z.infer<typeof ContractRegistryEntry>;

/** D07 clarified classes. */
export const QuoteAttemptClass = z.enum(["OK", "NO_QUOTE", "NETWORK_ERROR", "TIMEOUT", "INVALID_OUTPUT"]);
export const QuoteAttempt = z.strictObject({
  routeId: z.string().min(1),
  amountBaseUnits: DecimalString,
  privacyMode: z.enum(["public", "basic", "advanced"]),
  scheduledBucketUTC: IsoDateTime,
  attemptNo: z.number().int().positive(),
  dry: z.literal(true),
  class: QuoteAttemptClass,
  amountOutBaseUnits: DecimalString.nullable(),
  fetchedAtUTC: IsoDateTime,
  rawObjectHash: Sha256Hex.nullable(),
});
export type QuoteAttempt = z.infer<typeof QuoteAttempt>;

export const WatermarkState = z.enum(["fresh", "late", "partial", "unavailable"]);
export type WatermarkState = z.infer<typeof WatermarkState>;
export const SourceWatermark = z.strictObject({
  providerId: z.string(),
  newestEventTime: IsoDateTime.nullable(),
  lastFullScanAt: IsoDateTime.nullable(),
  gapCount: z.number().int().nonnegative(),
  providerLagSeconds: z.number().nonnegative().nullable(),
  schemaVersion: z.string().nullable(),
  state: WatermarkState,
});
export type SourceWatermark = z.infer<typeof SourceWatermark>;
