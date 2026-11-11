/**
 * Claim provenance policy (ch.10 "Evidence graph semantics", ch.27 Provenance, 16b W08). One policy for every element:
 * an incomplete numeric claim is STORED, never dropped, and projected as `unsupported` with an explicit `missing` list.
 */

/** The full provenance tuple a numeric claim must carry. */
export const PROVENANCE_ELEMENTS = [
  "result_rows",
  "result_columns",
  "query_hash",
  "semantic_version",
  "source_manifest_hash",
  "quant_model_revision",
] as const;
export type ProvenanceElement = (typeof PROVENANCE_ELEMENTS)[number];

/** Where each tuple element lives inside `claim.data.provenance`. */
const FIELD: Record<ProvenanceElement, string> = {
  result_rows: "resultRowIds",
  result_columns: "columnIds",
  query_hash: "queryHash",
  semantic_version: "semanticModelVersion",
  source_manifest_hash: "rawSourceManifestHash",
  quant_model_revision: "quantModelRevision",
};

const present = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.length > 0 && v.every((x) => present(x))
    : typeof v === "string"
      ? v.trim() !== ""
      : false;

export const isNumericClaim = (data: Record<string, unknown> | undefined): boolean =>
  data?.numeric === true || (data?.provenance !== undefined && data.numeric !== false);

/** Missing provenance elements of a numeric claim (empty when complete or when the claim is not numeric). */
export function missingProvenance(
  data: Record<string, unknown> | undefined,
  required: readonly ProvenanceElement[] = PROVENANCE_ELEMENTS,
): ProvenanceElement[] {
  if (!isNumericClaim(data)) return [];
  const prov = (data?.provenance ?? {}) as Record<string, unknown>;
  return required.filter((el) => !present(prov[FIELD[el]]));
}

/** Web evidence (a `source` node with `data.web`): title, canonical URL, retrieval time and quoted fragment hash. */
export const WEB_ELEMENTS = ["title", "canonical_url", "retrieved_at", "fragment_hash"] as const;
const WEB_FIELD: Record<(typeof WEB_ELEMENTS)[number], string> = {
  title: "title",
  canonical_url: "canonicalUrl",
  retrieved_at: "retrievedAt",
  fragment_hash: "quotedFragmentHash",
};

export function webEvidenceStatus(data: Record<string, unknown> | undefined): {
  isWeb: boolean;
  missing: string[];
  confidenceTier: string | null;
} {
  const web = data?.web as Record<string, unknown> | undefined;
  if (!web || typeof web !== "object") return { isWeb: false, missing: [], confidenceTier: null };
  const missing = WEB_ELEMENTS.filter((el) => !present(web[WEB_FIELD[el]]));
  // An item missing any element can never carry more than the lowest confidence tier.
  return {
    isWeb: true,
    missing,
    confidenceTier: missing.length
      ? "unverified"
      : typeof web.confidenceTier === "string"
        ? web.confidenceTier
        : "unverified",
  };
}

export interface ClaimLike {
  id: string;
  label: string;
  support?: string;
  missing?: string[];
  data?: Record<string, unknown>;
}

/** What may be published as supported. Pure, so the policy itself is testable (including a deliberately broken one). */
export function publicationSets(claims: ClaimLike[], opts: { includeUnsupportedInEligible?: boolean } = {}) {
  const supported = claims.filter((c) => c.support === "supported");
  const unsupported = claims.filter((c) => c.support !== "supported");
  const eligible = opts.includeUnsupportedInEligible ? [...supported, ...unsupported] : supported;
  return {
    supportedClaimIds: supported.map((c) => c.id),
    publicationEligibleIds: eligible.map((c) => c.id),
    publishedNumbers: eligible
      .filter((c) => isNumericClaim(c.data))
      .map((c) => ({ claimId: c.id, value: c.data?.value ?? null })),
    unsupportedSection: {
      label: "UNSUPPORTED: excluded from supported publication",
      claims: unsupported.map((c) => ({ claimId: c.id, label: c.label, missing: c.missing ?? [] })),
    },
  };
}
