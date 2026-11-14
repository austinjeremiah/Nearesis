import type { AssetAlias } from "@nearesis/contracts";

/**
 * Effective-dated lookups use half-open intervals [validFrom, validTo): validFrom is inclusive, validTo is exclusive
 * (a null validTo is open-ended). The Nov 9 2026 migration is therefore: old ID valid_to = 2026-11-09T00:00:00Z,
 * new ID valid_from = 2026-11-09T00:00:00Z, so the instant of the cutover resolves to the new ID.
 */
export const inInterval = (at: string, validFrom: string, validTo: string | null): boolean => {
  const t = Date.parse(at);
  return t >= Date.parse(validFrom) && (validTo === null || t < Date.parse(validTo));
};

export type AssetResolution =
  | { status: "found"; canonicalAssetId: string; verification: AssetAlias["verification"]; alias: AssetAlias }
  | { status: "ambiguous"; candidates: AssetAlias[] }
  | { status: "unknown" };

export class AssetRegistry {
  constructor(readonly aliases: AssetAlias[]) {}

  /** provider ID observed at time `at` -> canonical asset. */
  resolve(providerId: string, providerAssetId: string, at: string): AssetResolution {
    const hits = this.aliases.filter(
      (a) =>
        a.providerId === providerId &&
        a.providerAssetId === providerAssetId &&
        inInterval(at, a.validFrom, a.validTo),
    );
    if (hits.length === 0) return { status: "unknown" };
    const canon = new Set(hits.map((h) => h.canonicalAssetId));
    if (canon.size > 1 || hits.some((h) => h.verification === "ambiguous"))
      return { status: "ambiguous", candidates: hits };
    const h = hits[0] as AssetAlias;
    return { status: "found", canonicalAssetId: h.canonicalAssetId, verification: h.verification, alias: h };
  }

  /** canonical asset -> the provider ID that was valid at time `at`. */
  historicalId(providerId: string, canonicalAssetId: string, at: string): string | null {
    const hits = this.aliases.filter(
      (a) =>
        a.providerId === providerId &&
        a.canonicalAssetId === canonicalAssetId &&
        inInterval(at, a.validFrom, a.validTo),
    );
    const ids = new Set(hits.map((h) => h.providerAssetId));
    return ids.size === 1 ? ([...ids][0] as string) : null;
  }

  /** Visible changelog markers for ID migrations (ch.07 quality rules). */
  migrationMarkers(): Array<{ canonicalAssetId: string; at: string; from: string; to: string }> {
    const out: Array<{ canonicalAssetId: string; at: string; from: string; to: string }> = [];
    for (const a of this.aliases) {
      if (a.validTo === null) continue;
      const next = this.aliases.find(
        (b) =>
          b.canonicalAssetId === a.canonicalAssetId &&
          b.providerId === a.providerId &&
          b.providerAssetId !== a.providerAssetId &&
          Date.parse(b.validFrom) === Date.parse(a.validTo as string),
      );
      if (next)
        out.push({
          canonicalAssetId: a.canonicalAssetId,
          at: a.validTo,
          from: a.providerAssetId,
          to: next.providerAssetId,
        });
    }
    return out.sort((x, y) => (x.at + x.canonicalAssetId).localeCompare(y.at + y.canonicalAssetId));
  }
}
