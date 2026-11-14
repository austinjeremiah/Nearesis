import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { PanelSpec } from "@nearesis/contracts";
import { KernelError } from "../errors.ts";

/**
 * The data seam of a historical or pinned read. `execute` runs one panel's query. A pin fixes the source watermark per
 * source and the semantic version per metric; `watermark: null` means live. The kernel never reaches for live data
 * when a pin is supplied: the executor receives the pin and is the only thing that touches the warehouse.
 */
export interface PanelPin {
  watermark: Record<string, string> | null;
  semanticVersions: Record<string, string>;
  /** Branch overlays may exclude accounts etc. (W13); the executor applies them. */
  exclusions?: Record<string, unknown>;
}
export interface PanelExecutor {
  /** Source ids this panel reads. */
  sources(panel: PanelSpec): string[];
  execute(panel: PanelSpec, pin: PanelPin): Promise<unknown>;
}

export interface PanelResultRecord {
  resultHash: string;
  result: unknown;
  cacheKey: string;
  queryHash: string;
}
export type PanelResults = Record<string, PanelResultRecord>;

const hash = (v: unknown): string => sha256Hex(canonicalJson(v ?? null));

/** Cache key `(queryHash, semanticVersion, sourceSnapshot)` (ch.09 "Refresh architecture"). Live uses the literal `live`. */
export function panelCacheKey(
  queryHash: string,
  semanticVersions: Record<string, string>,
  sourceSnapshot: { manifestHash?: string; watermark?: Record<string, string> } | null,
): string {
  return hash({
    queryHash,
    semanticVersions,
    sourceSnapshot: sourceSnapshot
      ? { manifestHash: sourceSnapshot.manifestHash ?? null, watermark: sourceSnapshot.watermark ?? null }
      : "live",
  });
}

export const panelResultsHash = (r: PanelResults): string =>
  hash(Object.fromEntries(Object.entries(r).map(([id, v]) => [id, { h: v.resultHash, k: v.cacheKey }])));

/** Finalization-time capture: refuses to finalize unless every needed source has a watermark. */
export async function capturePanelResults(
  executor: PanelExecutor,
  panels: PanelSpec[],
  watermark: Record<string, string> | null,
  semanticVersions: Record<string, string>,
  manifestHash: string | null,
): Promise<PanelResults> {
  const missing = new Set<string>();
  for (const p of panels) for (const s of executor.sources(p)) if (!watermark?.[s]) missing.add(s);
  if (missing.size)
    throw new KernelError(
      "VALIDATION_FAILED",
      "WATERMARK_MISSING",
      "A snapshot cannot be finalized without a watermark for every source its panels read.",
      {
        details: [...missing]
          .sort()
          .map((s) => ({ path: `sourceSnapshot.watermark.${s}`, issue: "missing" })),
      },
    );
  const out: PanelResults = {};
  for (const p of panels) {
    const result = await executor.execute(p, { watermark, semanticVersions });
    out[p.panelId] = {
      result,
      resultHash: hash(result),
      cacheKey: panelCacheKey(p.queryRef.hash, semanticVersions, {
        manifestHash: manifestHash ?? undefined,
        watermark: watermark!,
      }),
      queryHash: p.queryRef.hash,
    };
  }
  return out;
}
