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
  /**
   * UTC days that hold at least one loaded swap. When given, a day inside the range with none is NEVER complete: the loaded
   * range is only contiguous by cursor, not by day (a provider cursor can jump over weeks), so "inside the range" is not
   * evidence. Absent = legacy behaviour (every interior day is complete), kept for callers that cannot know.
   */
  swapDays?: ReadonlySet<string>;
  /** Empty days the provider itself confirmed empty (a time-filtered refetch returned nothing): these are complete with zero swaps. */
  confirmedEmptyDays?: ReadonlySet<string>;
}

/** Reason stored for a day proven empty at the provider; the refresh preserves such a row while the day stays empty. */
export const PROVIDER_EMPTY_CONFIRMED = "PROVIDER_EMPTY_CONFIRMED";
export const NO_SWAPS_LOADED = "NO_SWAPS_LOADED";
export const ADJACENT_TO_EMPTY_DAYS = "ADJACENT_TO_EMPTY_DAYS";

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
  // an interior day with no loaded swap that the provider did not confirm empty is a hole in the loaded data
  const hole = (d: string): boolean =>
    !!i.swapDays && d >= i.minDay && d <= i.maxDay && !i.swapDays.has(d) && !i.confirmedEmptyDays?.has(d);
  for (let d = i.minDay; d <= i.maxDay; d = addDays(d, 1)) {
    const gap = gapReason.get(d);
    if (gap) out.push({ day: d, state: "partial", reason: gap });
    else if (d === i.minDay && d !== i.windowFrom)
      out.push({ day: d, state: "partial", reason: "OLDEST_EDGE_DAY" });
    else if (d === i.maxDay) out.push({ day: d, state: "partial", reason: "STILL_FILLING" });
    else if (hole(d)) out.push({ day: d, state: "partial", reason: NO_SWAPS_LOADED });
    else if (i.swapDays && !i.swapDays.has(d))
      out.push({ day: d, state: "complete", reason: PROVIDER_EMPTY_CONFIRMED });
    // the days on either side of a hole were cut by a page boundary part-way through the day
    else if (hole(addDays(d, -1)) || hole(addDays(d, 1)))
      out.push({ day: d, state: "partial", reason: ADJACENT_TO_EMPTY_DAYS });
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
       FROM quality_gaps FINAL WHERE provider_id = {p:String} AND dataset = {d:String}
          AND reason_code NOT LIKE 'USD_IMPLAUSIBLE:%'`, // a quarantined USD value does not make the whole day's coverage partial
    { p: EXPLORER_PROVIDER, d: EXPLORER_DATASET },
  );
  const swapDays = new Set(
    (await q<{ d: string }>(ch, "SELECT DISTINCT toString(created_day) AS d FROM intents_swaps")).map(
      (x) => x.d,
    ),
  );
  const have = new Map(
    (
      await q<{ d: string; state: string; reason: string | null }>(
        ch,
        `SELECT toString(day) AS d, state, reason FROM source_coverage FINAL WHERE provider_id = {p:String} AND dataset = {d:String}`,
        { p: EXPLORER_PROVIDER, d: EXPLORER_DATASET },
      )
    ).map((x) => [x.d, x]),
  );
  // evidence a day is genuinely empty at the provider: only a row written by the refetch tool, kept while the day holds no swap
  const confirmedEmptyDays = new Set(
    [...have.values()]
      .filter((h) => h.state === "complete" && h.reason === PROVIDER_EMPTY_CONFIRMED && !swapDays.has(h.d))
      .map((h) => h.d),
  );
  const want = explorerCoverageDays({
    minDay: r[0].lo,
    maxDay: r[0].hi,
    gaps: gaps.map((g) => ({ from: g.fu, to: g.tu, reasonCode: g.rc })),
    swapDays,
    confirmedEmptyDays,
    ...(windowFrom ? { windowFrom } : {}),
  });
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
