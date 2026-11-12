import type { ClickHouseClient } from "@clickhouse/client";
import { coverageRows, insertLive, type CoverageInput } from "./ch.ts";
import { addDays } from "./plan.ts";

export const EXPLORER_PROVIDER = "near-explorer";
export const EXPLORER_DATASET = "intents_swaps";

type Day = Pick<CoverageInput, "day" | "state" | "reason">;

export interface ExplorerCoverageInput {
  /** Oldest and newest UTC day with at least one loaded swap (the loaded range is contiguous: the collector pages by cursor). */
  minDay: string;
  maxDay: string;
  /** Quarantined-page / provider gaps as UTC instants (ISO) with their reason code. */
  gaps: Array<{ from: string; to: string; reasonCode: string }>;
  /** Set when the collector finished the whole window: minDay === windowFrom is then a fully loaded day. */
  windowFrom?: string;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * Honest per-day coverage of the loaded range. The oldest day may be cut by the page edge and the newest day is still filling
 * (or the loader is behind): both are partial. A day touched by a gap is partial with the gap's reason. Everything strictly
 * inside the contiguous range is complete. Days outside the range get no row (unknown, never complete).
 */
export function explorerCoverageDays(i: ExplorerCoverageInput): Day[] {
  const gapReason = new Map<string, string>();
  for (const g of i.gaps) {
    const reason = g.reasonCode.split(":")[0] ?? g.reasonCode;
    for (let d = dayOf(g.from); d <= dayOf(g.to); d = addDays(d, 1))
      if (!gapReason.has(d)) gapReason.set(d, reason);
  }
  const out: Day[] = [];
  for (let d = i.minDay; d <= i.maxDay; d = addDays(d, 1)) {
    const gap = gapReason.get(d);
    if (gap) out.push({ day: d, state: "partial", reason: gap });
    else if (d === i.minDay && d !== i.windowFrom)
      out.push({ day: d, state: "partial", reason: "OLDEST_EDGE_DAY" });
    else if (d === i.maxDay) out.push({ day: d, state: "partial", reason: "STILL_FILLING" });
    else out.push({ day: d, state: "complete", reason: null });
  }
  return out;
}

const q = async <T>(
  ch: ClickHouseClient,
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> =>
  (await (await ch.query({ query, query_params: params, format: "JSONEachRow" })).json()) as T[];

/**
 * Writes Explorer swap coverage derived from the loaded data. Idempotent: only days whose (state, reason) differ from the
 * current coverage row are inserted (no churn of identical versions), never deletes, never touches other datasets.
 * `windowFrom`: when the collector finished the whole window, the oldest day is the window start and is complete, not an edge.
 * Returns the number of rows written.
 */
export async function refreshExplorerCoverage(
  ch: ClickHouseClient,
  nowMs: number = Date.now(),
  windowFrom: string | null = null,
): Promise<number> {
  const r = await q<{ lo: string; hi: string; n: string }>(
    ch,
    "SELECT toString(min(created_day)) AS lo, toString(max(created_day)) AS hi, toString(count()) AS n FROM intents_swaps",
  );
  if (!r[0] || r[0].n === "0") return 0;
  const gaps = await q<{ fu: string; tu: string; rc: string }>(
    ch,
    `SELECT formatDateTime(from_utc, '%Y-%m-%dT%H:%i:%S', 'UTC') AS fu, formatDateTime(to_utc, '%Y-%m-%dT%H:%i:%S', 'UTC') AS tu, reason_code AS rc
       FROM quality_gaps FINAL WHERE provider_id = {p:String} AND dataset = {d:String}`,
    { p: EXPLORER_PROVIDER, d: EXPLORER_DATASET },
  );
  const want = explorerCoverageDays({
    minDay: r[0].lo,
    maxDay: r[0].hi,
    gaps: gaps.map((g) => ({ from: g.fu, to: g.tu, reasonCode: g.rc })),
    ...(windowFrom ? { windowFrom } : {}),
  });
  const have = new Map(
    (
      await q<{ d: string; state: string; reason: string | null }>(
        ch,
        `SELECT toString(day) AS d, state, reason FROM source_coverage FINAL WHERE provider_id = {p:String} AND dataset = {d:String}`,
        { p: EXPLORER_PROVIDER, d: EXPLORER_DATASET },
      )
    ).map((x) => [x.d, x]),
  );
  const changed = want.filter((w) => {
    const h = have.get(w.day);
    if (!h) return true;
    return h.state !== w.state || (h.reason ?? null) !== (w.reason ?? null);
  });
  await insertLive(
    ch,
    "source_coverage",
    coverageRows(
      changed.map((c) => ({
        provider_id: EXPLORER_PROVIDER,
        dataset: EXPLORER_DATASET,
        ...c,
        version: nowMs,
      })),
    ),
  );
  return changed.length;
}
