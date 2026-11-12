/** Reason code of a fresh-data gate decision made because the live catalog could not be read. */
export const CATALOG_UNAVAILABLE = "catalog_unavailable";

/**
 * The fresh-data gate fails closed: a live run whose catalog yielded no metric-to-source map cannot be shown to read
 * healthy sources, so it is blocked instead of being let through on missing information.
 */
export function catalogUnreadable(metricSources: Record<string, string[]> | null | undefined): boolean {
  return !metricSources || Object.keys(metricSources).length === 0;
}

/**
 * A stored context with no metric-to-source map is not final: the catalog read failed (or the context predates a fix), so
 * binding is retried for a run that is still being set up instead of freezing "unreadable" for good.
 */
export function contextNeedsRebind(
  ctx: { metricSources?: Record<string, string[]> } | null | undefined,
): boolean {
  return !!ctx && catalogUnreadable(ctx.metricSources);
}
