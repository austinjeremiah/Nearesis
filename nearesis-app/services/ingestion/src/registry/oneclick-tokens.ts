import type { AssetAlias } from "@nearesis/contracts";
import type { TokenResponse } from "../adapters/oneclick.ts";

export const ONECLICK_PROVIDER = "intents-1click";
export const ONECLICK_TOKENS_URL = "https://1click.chaindefuser.com/v0/tokens";
/**
 * The token list is a snapshot of the present: it carries no history. An asset ID is a chain-qualified contract
 * identifier, so the binding id -> asset is treated as valid from the start of the live window (the first day of any
 * live swap) and open-ended, unless the caller supplies a dated cutover from a documented source.
 */
export const DEFAULT_VALID_FROM = "2026-05-01T00:00:00.000Z";

const DEPRECATED = /\s*\(DEPRECATED\)\s*$/i;

export type UnknownReason =
  | "no_coingecko_identity"
  | "conflicting_identity_for_symbol"
  | "empty_symbol"
  | "duplicate_asset_id_conflict";

export interface RegistryEntry {
  providerAssetId: string;
  canonicalAssetId: string | null;
  verification: AssetAlias["verification"];
  unknownReason: UnknownReason | null;
  symbolObserved: string;
  blockchain: string;
  coingeckoId: string | null;
  deprecated: boolean;
  validFrom: string;
  validTo: string | null;
}

export interface BuildOptions {
  validFrom?: string;
  /**
   * Dated cutovers for deprecated or migrated IDs (asset ID -> ISO instant at which the ID stops being valid, exclusive).
   * The list itself does not date them, so production passes none and the alias stays open-ended.
   */
  validTo?: Record<string, string>;
}

/**
 * Canonical asset = the listed symbol (suffix "(DEPRECATED)" removed). It is "verified" only if the entry declares a
 * CoinGecko identity AND every listed entry with that canonical symbol declares the same one. Anything else stays
 * unknown with a reason; nothing is guessed.
 */
export function buildRegistryEntries(tokens: TokenResponse[], opts: BuildOptions = {}): RegistryEntry[] {
  const validFrom = opts.validFrom ?? DEFAULT_VALID_FROM;
  const bySymbol = new Map<string, Set<string | null>>();
  const sym = (t: TokenResponse): string => t.symbol.replace(DEPRECATED, "").trim();
  for (const t of tokens) {
    const s = sym(t);
    if (!bySymbol.has(s)) bySymbol.set(s, new Set());
    bySymbol.get(s)!.add(t.coingeckoId ?? null);
  }
  const seen = new Map<string, string>();
  const out: RegistryEntry[] = [];
  for (const t of tokens) {
    const s = sym(t);
    const cg = t.coingeckoId ?? null;
    const ids = bySymbol.get(s)!;
    let canonical: string | null = s;
    let verification: AssetAlias["verification"] = "verified";
    let reason: UnknownReason | null = null;
    if (s === "") {
      canonical = null;
      verification = "unverified";
      reason = "empty_symbol";
    } else if (cg === null) {
      canonical = null;
      verification = "unverified";
      reason = "no_coingecko_identity";
    } else if (ids.size > 1) {
      canonical = null;
      verification = "ambiguous";
      reason = "conflicting_identity_for_symbol";
    }
    const prior = seen.get(t.assetId);
    if (prior !== undefined && prior !== canonical) {
      canonical = null;
      verification = "ambiguous";
      reason = "duplicate_asset_id_conflict";
    }
    seen.set(t.assetId, canonical ?? "");
    out.push({
      providerAssetId: t.assetId,
      canonicalAssetId: canonical,
      verification,
      unknownReason: reason,
      symbolObserved: t.symbol,
      blockchain: t.blockchain,
      coingeckoId: cg,
      deprecated: DEPRECATED.test(t.symbol),
      validFrom,
      validTo: opts.validTo?.[t.assetId] ?? null,
    });
  }
  return out;
}

/** Contract-level aliases (what AssetRegistry consumes). Unknown entries are kept with their non-verified state. */
export function entriesToAliases(entries: RegistryEntry[], evidenceUrl = ONECLICK_TOKENS_URL): AssetAlias[] {
  return entries
    .filter((e) => e.canonicalAssetId !== null)
    .map((e) => ({
      canonicalAssetId: e.canonicalAssetId as string,
      providerAssetId: e.providerAssetId,
      providerId: ONECLICK_PROVIDER,
      validFrom: new Date(e.validFrom).toISOString(),
      validTo: e.validTo === null ? null : new Date(e.validTo).toISOString(),
      evidenceUrl,
      verification: e.verification,
    }));
}
