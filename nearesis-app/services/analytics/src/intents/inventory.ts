/**
 * What the Explorer API actually identifies (investigated 2026-11-13):
 *  - OpenAPI https://explorer.near-intents.org/api/v0/openapi.yaml (sha256 eec0c126...fb5e, see services/ingestion/docs/SOURCES_CHECKED.md)
 *  - parser services/ingestion/src/adapters/explorer-parse.ts
 *  - every archived page in .data/backfill/raw: 4,930,000 transaction objects scanned; the key set equals the documented schema, no extra key.
 */
export type Identifiability = "identified" | "derived" | "not_provided";

export interface FieldFact {
  concept: string;
  status: Identifiability;
  source: string;
  note: string;
}

export const FIELD_INVENTORY: FieldFact[] = [
  {
    concept: "origin asset",
    status: "identified",
    source: "originAsset (provider asset id, e.g. nep141:eth.omft.near)",
    note: "Mapped to a canonical asset through the asset registry (verified rows only); otherwise explicitly unmapped.",
  },
  {
    concept: "destination asset",
    status: "identified",
    source: "destinationAsset",
    note: "Same registry mapping as origin.",
  },
  {
    concept: "origin chain",
    status: "derived",
    source: "asset_registry.blockchain (1Click token list) else the documented asset id grammar",
    note: "The Explorer has no chain field. Chain is a property of the asset id; unresolvable ids are 'unknown' and counted.",
  },
  {
    concept: "destination chain",
    status: "derived",
    source: "same as origin chain",
    note: "recipientType DESTINATION_CHAIN vs INTENTS says whether the output stays inside Intents.",
  },
  {
    concept: "status",
    status: "identified",
    source:
      "status: SUCCESS | FAILED | REFUNDED | PROCESSING (INCOMPLETE_DEPOSIT, PENDING_DEPOSIT exist in the spec, none present in the live table)",
    note: "Optional in the schema; absent => UNKNOWN.",
  },
  {
    concept: "created / deposit-detected time",
    status: "identified",
    source: "createdAt, createdAtTimestamp",
    note: "One timestamp per swap. The spec does not say whether it is quote, deposit or intent time.",
  },
  {
    concept: "settlement time / completion time",
    status: "not_provided",
    source: "-",
    note: "No settled_at, completed_at or updated_at in the response. Settlement duration cannot be measured from the Explorer.",
  },
  {
    concept: "deposit confirmation time",
    status: "not_provided",
    source: "-",
    note: "Only transaction hash lists (originChainTxHashes, nearTxHashes, destinationChainTxHashes) are given; no block times.",
  },
  {
    concept: "refund state",
    status: "identified",
    source:
      "status = REFUNDED, refundReason (enum such as NO_LIQUIDITY, INTENT_SUBMIT_FAILED), refundTo, refundFee",
    note: "refundReason/refundFee are in the raw archive; the live swap table keeps status only.",
  },
  {
    concept: "USD value",
    status: "identified",
    source: "amountInUsd, amountOutUsd (provider valuation; may be null)",
    note: "Valuation time is not documented. Null stays null.",
  },
  {
    concept: "amounts",
    status: "identified",
    source: "amountIn/amountOut smallest-unit strings; '' or 0 while in flight",
    note: "REFUNDED swaps can report unknown amounts.",
  },
  {
    concept: "solver / relayer / market-maker identity",
    status: "not_provided",
    source: "-",
    note: "No solver, relayer, filler, market-maker or executor field. nearTxHashes are NEAR transactions, not an identity.",
  },
  {
    concept: "quote linkage (swap -> the quote that produced it)",
    status: "not_provided",
    source: "-",
    note: "No quote id or correlationId on a swap. depositAddress is the only key shared with a real quote, and dry quotes (the only kind Nearesis may request) carry no depositAddress.",
  },
  {
    concept: "partner / integrator",
    status: "identified",
    source: "referral, appFees[].recipient",
    note: "Channel attribution, not solver attribution.",
  },
  {
    concept: "privacy",
    status: "identified",
    source: "depositType / recipientType / refundType in ORIGIN_CHAIN | INTENTS | CONFIDENTIAL_INTENTS",
    note: "privacy_era is derived by ingestion; after the private-settlement transition on-chain observability is incomplete.",
  },
];

export const SOURCES = [
  "https://explorer.near-intents.org/api/v0/openapi.yaml",
  "https://1click.chaindefuser.com/docs/v0/openapi.yaml",
  "https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature",
  "services/ingestion/docs/SOURCES_CHECKED.md",
];
