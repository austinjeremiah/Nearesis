import type { DataFrameEnvelope } from "@nearesis/contracts";

/**
 * Failure propagation for a degraded source (ch.25 "Failure propagation example", ch.13 backpressure; ch.16b B09).
 * A collector that loses its credential marks its source `degraded`/`unavailable`; the semantic layer then reports the
 * stale window instead of a clean result, analyses that need fresh data are `BLOCKED_SOURCE`, the canvas states the last
 * good watermark, and current-date publication is held (or honestly downgraded to the frozen window).
 */
export type SourceStatus = "ok" | "degraded" | "unavailable";
export interface SourceHealth {
  status: SourceStatus;
  reason: string | null;
  /** Watermark of the last data the source delivered intact (null when it never delivered). */
  lastGoodWatermark: string | null;
  since: string;
}

/** Process-wide registry on globalThis so the plugin module and the harness that feeds it share one view. */
const KEY = Symbol.for("nearesis.near-thesis.source-health");
const reg = (): Map<string, SourceHealth> => {
  const g = globalThis as unknown as Record<symbol, Map<string, SourceHealth> | undefined>;
  return (g[KEY] ??= new Map());
};
export const registerSourceHealth = (sourceId: string, h: SourceHealth): void => void reg().set(sourceId, h);
export const clearSourceHealth = (sourceId?: string): void =>
  void (sourceId ? reg().delete(sourceId) : reg().clear());
export const sourceHealthOf = (sourceId: string): SourceHealth | undefined => reg().get(sourceId);

/** `intents-1click:intents_swaps` -> `intents-1click` */
export const sourceKey = (metricSource: string): string => metricSource.split(":")[0]!;

/** Marks an envelope stale when any source behind it is degraded: a visible gap from the last good watermark, never a zero. */
export function annotateEnvelope(
  env: DataFrameEnvelope,
  metricSources: string[],
  now: Date = new Date(),
): DataFrameEnvelope {
  const degraded = [...new Set(metricSources.map(sourceKey))].flatMap((k) => {
    const h = sourceHealthOf(k);
    return h && h.status !== "ok" ? [[k, h] as const] : [];
  });
  if (!degraded.length) return env;
  const gaps = [...env.gaps];
  const sourceWatermarks = { ...env.sourceWatermarks };
  for (const [k, h] of degraded) {
    sourceWatermarks[k] = h.lastGoodWatermark;
    gaps.push({
      from: h.lastGoodWatermark ?? h.since,
      to: now.toISOString(),
      reason: `source_${h.status}:${h.reason ?? "unknown"}`,
    });
  }
  return { ...env, certification: "stale", gaps, sourceWatermarks };
}

export type TaskNeeds = "fresh" | "frozen";
export interface GateDecision {
  state: "RUN" | "BLOCKED_SOURCE";
  reason_code: string | null;
  sources: Array<{ source: string; status: SourceStatus; reason: string | null }>;
}
/** A task that needs fresh data is `BLOCKED_SOURCE` while a source it reads is not ok; a frozen-data task runs. */
export function gateTask(
  needs: TaskNeeds,
  sources: string[],
  lookup: (sourceId: string) => SourceHealth | undefined = sourceHealthOf,
): GateDecision {
  const st = sources.map((s) => {
    const h = lookup(sourceKey(s));
    return { source: sourceKey(s), status: (h?.status ?? "ok") as SourceStatus, reason: h?.reason ?? null };
  });
  const bad = st.filter((x) => x.status !== "ok");
  return needs === "fresh" && bad.length
    ? {
        state: "BLOCKED_SOURCE",
        reason_code: `source_${bad[0]!.status}:${bad[0]!.reason ?? "unknown"}`,
        sources: st,
      }
    : { state: "RUN", reason_code: null, sources: st };
}

/** Banner a panel carries while its source is degraded: states the last good watermark and that the data is stale. */
export function degradedBanner(sourceId: string, h: SourceHealth): string {
  return `DEGRADED SOURCE ${sourceId}: ${h.reason ?? h.status}. Showing the last good data, watermark ${h.lastGoodWatermark ?? "none"}; newer data is not shown.`;
}

export interface CurrentDateClaim {
  claim: string;
  window: { from: string; to: string };
  sources: string[];
}
/**
 * Publication of a claim about the current date is held while any source it needs is degraded. The only way forward is
 * recovery, or an honest scope downgrade to the frozen window (which the caller must label).
 */
export function holdCurrentDateClaim(c: CurrentDateClaim): {
  held: boolean;
  reason_code: string | null;
  downgrade: { window: { from: string; to: string }; label: string } | null;
} {
  const bad = c.sources
    .map((s) => ({ s: sourceKey(s), h: sourceHealthOf(sourceKey(s)) }))
    .filter((x) => x.h && x.h.status !== "ok");
  if (!bad.length) return { held: false, reason_code: null, downgrade: null };
  const lastGood = bad
    .map((x) => x.h!.lastGoodWatermark)
    .filter((x): x is string => !!x)
    .sort()[0];
  return {
    held: true,
    reason_code: `source_${bad[0]!.h!.status}`,
    downgrade: lastGood
      ? {
          window: { from: c.window.from, to: lastGood },
          label: `scope downgraded to the frozen window ending ${lastGood}; the current-date claim is not made`,
        }
      : null,
  };
}

export interface ProviderState {
  id: string;
  kind: "data" | "semantic" | "inference" | "proof";
  status: SourceStatus;
  reason: string | null;
  lastGoodWatermark: string | null;
}
/** Overall status of the slice. `ok` only when every provider is ok: a mixed outage is `partial`, never a success. */
export function statusBoard(providers: ProviderState[]): {
  overall: "ok" | "partial" | "degraded";
  stale: ProviderState[];
  providers: ProviderState[];
} {
  const bad = providers.filter((p) => p.status !== "ok");
  return {
    overall: bad.length === 0 ? "ok" : bad.length === providers.length ? "degraded" : "partial",
    stale: bad,
    providers,
  };
}
