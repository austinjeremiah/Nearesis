import { loadLiveRegistry, loadRegistry } from "@nearesis/analytics";
import type { Registry } from "@nearesis/analytics";
import type { MetricCatalog, MonitoringConfig } from "@nearesis/kernel";

/** NEAR mainnet genesis (UTC): no source holds data before it, so an earlier anchor is outside the accessible range. */
export const SOURCE_RANGE_START = "2020-07-22T00:00:00Z";

/** The monitor-visible catalog built from the certified registries (fixture and live). Pure, so it can be tested. */
export function catalogFromRegistries(
  registries: readonly Registry[],
  now: Date = new Date(),
): MetricCatalog {
  const metrics: Record<string, { unit: string | null }> = {};
  const versions = new Set<string>();
  for (const r of registries) {
    versions.add(r.semanticVersion);
    for (const m of r.metrics) if (m.certified) metrics[m.id] = { unit: m.unit ?? null };
  }
  const semanticVersion = [...versions].sort().at(-1) ?? "0.0.0";
  return {
    semanticVersion,
    knownVersions: [...versions],
    metrics,
    accessibleRange: { start: SOURCE_RANGE_START, end: now.toISOString() },
  };
}

/**
 * Production monitoring configuration (used by `main.ts`): the real semantic catalog, REQUIRED. If the registries cannot be
 * loaded (missing file, hash mismatch) the provider returns nothing and the kernel rejects the command with
 * `CATALOG_UNAVAILABLE`; validation is never silently skipped. A successful load is cached, a failure is retried.
 */
export function productionMonitoringConfig(
  load: () => readonly Registry[] = () => [loadRegistry(), loadLiveRegistry()],
): MonitoringConfig {
  let cached: readonly Registry[] | undefined;
  return {
    requireCatalog: true,
    catalog: () => {
      try {
        cached ??= load();
      } catch {
        return undefined;
      }
      return catalogFromRegistries(cached);
    },
  };
}
