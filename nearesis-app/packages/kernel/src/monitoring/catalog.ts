import { KernelError } from "../errors.ts";

/**
 * The semantic catalog as monitoring sees it (ch.11 "allowed metric", ch.20 rule `semanticVersion`). The kernel does not
 * own the catalog: the composition root injects it. When none is configured, metric, unit, semantic-version and
 * source-range checks are NOT enforced (see handoff: production wiring pending).
 */
export interface MetricCatalog {
  /** Current certified catalog version. */
  semanticVersion: string;
  /** Every catalog version a rule may pin (defaults to `[semanticVersion]`). */
  knownVersions?: readonly string[];
  metrics: Readonly<Record<string, { unit: string | null }>>;
  /** Accessible source range for time anchors (UTC, inclusive). */
  accessibleRange?: { start: string; end: string };
}

export interface MonitoringConfig {
  /** A fixed catalog, or a provider evaluated per command (so a registry that changes or fails is seen at once). */
  catalog?: MetricCatalog | (() => MetricCatalog | undefined);
  /**
   * Fail closed (production): when true, a command that needs the catalog is REJECTED (`CATALOG_UNAVAILABLE`, retryable)
   * if none can be resolved, never validated as if every metric were allowed.
   */
  requireCatalog?: boolean;
}

/** Resolves the catalog for one command; throws a retryable KernelError when it is required but unavailable. */
export function resolveCatalog(cfg: MonitoringConfig): MetricCatalog | undefined {
  let cat: MetricCatalog | undefined;
  try {
    cat = typeof cfg.catalog === "function" ? cfg.catalog() : cfg.catalog;
  } catch {
    cat = undefined;
  }
  if (!cat && cfg.requireCatalog)
    throw new KernelError(
      "UPSTREAM_DEGRADED",
      "CATALOG_UNAVAILABLE",
      "The semantic catalog is unavailable, so the metric cannot be validated.",
      { retryable: true, nextAction: "Retry shortly." },
    );
  return cat;
}
