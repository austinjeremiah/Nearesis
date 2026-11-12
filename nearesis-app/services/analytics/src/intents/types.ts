export const INTENTS_METRICS_VERSION = "intents-1.0.0";

export interface IntentsWindow {
  /** First day, inclusive, YYYY-MM-DD (UTC, created_day). */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export interface IntentsDayCoverage {
  day: string;
  state: string;
  reason: string | null;
}

/** What the numbers rest on. Attached to every result; a consumer must show it next to the chart. */
export interface IntentsCoverage {
  dataset: "intents_swaps";
  source: "NEAR Intents Explorer API (1Click transactions)";
  /** The Explorer feed is the 1Click transaction history. It is not every possible NEAR Intents interaction. */
  scopeNote: string;
  window: IntentsWindow;
  daysInWindow: number;
  completeDays: number;
  /** Days present in the source but not marked complete (partial, still filling). */
  incompleteDays: IntentsDayCoverage[];
  /** Days with no coverage record at all: unknown, never treated as zero activity. */
  missingDays: string[];
  swapRows: number;
  /** Rows whose USD valuation the provider did not supply (volume excludes them; they are counted, never zero). */
  usdUnknownRows: number;
  usdKnownShare: string | null;
  eraSplit: Record<string, number>;
  privateSettlementNote: string;
}

export interface IntentsProvenance {
  source: string;
  tables: string[];
  asOf: string | null;
  computedAt: string;
  metricVersion: string;
  method: string;
}

export interface IntentsChartHint {
  kind: "bar" | "line" | "heatmap" | "table" | "stacked_bar";
  x?: string;
  y?: string;
  series?: string;
  category?: string;
  value?: string;
}

export interface IntentsOk<T> {
  status: "OK";
  metric: string;
  definition: string;
  window: IntentsWindow | null;
  chart: IntentsChartHint;
  data: T;
  coverage: IntentsCoverage | null;
  provenance: IntentsProvenance;
  caveats: string[];
}

export interface IntentsCannotCompute {
  status: "CANNOT_COMPUTE";
  metric: string;
  /** The exact fields, linkages or sources that are absent. */
  missing: string[];
  explanation: string;
  /** Evidence the claim rests on (doc URLs, scanned counts). */
  evidence: string[];
  /** A clearly labelled substitute that IS computable, when one exists. It is not the requested metric. */
  alternative?: { metric: string; label: string; data: unknown };
  coverage: IntentsCoverage | null;
  provenance: IntentsProvenance;
}

export type IntentsResult<T> = IntentsOk<T> | IntentsCannotCompute;
