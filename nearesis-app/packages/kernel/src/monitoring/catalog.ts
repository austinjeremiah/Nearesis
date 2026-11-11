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
  catalog?: MetricCatalog;
}
