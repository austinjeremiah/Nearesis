/**
 * Declared SLOs (ch.13). Targets are the ch.13 performance objectives restated as good-event ratios; they are
 * engineering objectives, not measured claims. `availability` and `freshness` are the two classes ch.13 names for
 * burn-rate alerting. Windows follow the multi-window multi-burn-rate scheme for a 30-day objective.
 */
export interface SloDefinition {
  id: string;
  title: string;
  /** Fraction of good events required over `periodDays`. */
  objective: number;
  periodDays: number;
  /** What counts as a good event. */
  good: string;
  klass: "availability" | "freshness" | "latency";
  chapterRef: string;
}

export const SLOS: SloDefinition[] = [
  {
    id: "api_availability",
    title: "API availability",
    objective: 0.995,
    periodDays: 30,
    good: "HTTP response with status < 500 (429 overload shedding counts as good: a deliberate answer)",
    klass: "availability",
    chapterRef: "ch.13 Observability",
  },
  {
    id: "source_freshness",
    title: "Source freshness",
    objective: 0.99,
    periodDays: 30,
    good: "freshness probe where every required source watermark is within its declared lag bound",
    klass: "freshness",
    chapterRef: "ch.13 Backpressure / Observability",
  },
  {
    id: "workspace_load",
    title: "Cached workspace load p95 < 1.5 s",
    objective: 0.95,
    periodDays: 30,
    good: "cached workspace load completed in < 1500 ms",
    klass: "latency",
    chapterRef: "ch.13 performance table",
  },
  {
    id: "cached_query",
    title: "Cached semantic query p95 < 1 s",
    objective: 0.95,
    periodDays: 30,
    good: "cached semantic query answered in < 1000 ms",
    klass: "latency",
    chapterRef: "ch.13 performance table",
  },
  {
    id: "sse_propagation",
    title: "Event/SSE propagation p95 < 1 s",
    objective: 0.95,
    periodDays: 30,
    good: "event delivered to a subscriber < 1000 ms after commit",
    klass: "latency",
    chapterRef: "ch.13 performance table",
  },
  {
    id: "monitor_trigger",
    title: "Monitoring trigger to task p95 < 10 s",
    objective: 0.95,
    periodDays: 30,
    good: "task record visible < 10 s after the ingestion watermark",
    klass: "latency",
    chapterRef: "ch.13 performance table",
  },
];

export const sloById = (id: string): SloDefinition => {
  const s = SLOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown SLO ${id}`);
  return s;
};

/** Multi-window burn alert rules (SRE workbook, 30 d objective): both windows must exceed the factor. */
export interface BurnRule {
  severity: "page" | "ticket";
  longMs: number;
  shortMs: number;
  factor: number;
}
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const BURN_RULES: BurnRule[] = [
  { severity: "page", longMs: 1 * HOUR, shortMs: 5 * MIN, factor: 14.4 },
  { severity: "page", longMs: 6 * HOUR, shortMs: 30 * MIN, factor: 6 },
  { severity: "ticket", longMs: 72 * HOUR, shortMs: 6 * HOUR, factor: 1 },
];
