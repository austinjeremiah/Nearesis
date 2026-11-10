import { queryRows, FACT_TABLES, type ClickHouseClient } from "@nearesis/analytics";
import { createHash } from "node:crypto";
import { canonicalJson } from "@nearesis/analytics";

export type CoverageState = "complete" | "partial" | "unavailable";
export interface DayCoverage {
  state: CoverageState;
  reason: string | null;
}
/** key `${provider}:${dataset}` -> day -> coverage */
export type CoverageMap = Map<string, Map<string, DayCoverage>>;

const splitSource = (s: string) => {
  const i = s.indexOf(":");
  return { provider: s.slice(0, i), dataset: s.slice(i + 1) };
};

/** Coverage rows (FINAL, latest version) for the sources of a query within [fromDay, toDay]. Parameterized. */
export async function loadCoverage(
  ch: ClickHouseClient,
  sources: string[],
  fromDay: string,
  toDay: string,
): Promise<CoverageMap> {
  const map: CoverageMap = new Map();
  for (const s of new Set(sources)) {
    const { provider, dataset } = splitSource(s);
    const rows = await queryRows<{ d: string; state: CoverageState; reason: string | null }>(
      ch,
      `SELECT toString(day) AS d, state, reason FROM source_coverage FINAL
       WHERE provider_id = {p:String} AND dataset = {d:String} AND day >= {from:Date} AND day <= {to:Date}`,
      { p: provider, d: dataset, from: fromDay, to: toDay },
    );
    map.set(s, new Map(rows.map((r) => [r.d, { state: r.state, reason: r.reason }])));
  }
  return map;
}

export interface QualityGap {
  providerId: string;
  dataset: string;
  from: string;
  to: string;
  state: string;
  reasonCode: string;
}

export async function loadQualityGaps(
  ch: ClickHouseClient,
  sources: string[],
  fromIso: string,
  toIso: string,
): Promise<QualityGap[]> {
  const out: QualityGap[] = [];
  for (const s of new Set(sources)) {
    const { provider, dataset } = splitSource(s);
    const rows = await queryRows<{ fu: string; tu: string; state: string; reason_code: string }>(
      ch,
      `SELECT formatDateTime(from_utc, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS fu, formatDateTime(to_utc, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS tu, state, reason_code
       FROM quality_gaps FINAL
       WHERE provider_id = {p:String} AND dataset = {d:String} AND to_utc > parseDateTime64BestEffort({f:String}, 3, 'UTC') AND from_utc < parseDateTime64BestEffort({t:String}, 3, 'UTC')`,
      { p: provider, d: dataset, f: fromIso, t: toIso },
    );
    for (const r of rows)
      out.push({
        providerId: provider,
        dataset,
        from: r.from_utc,
        to: r.to_utc,
        state: r.state,
        reasonCode: r.reason_code,
      });
  }
  return out;
}

export async function loadWatermarks(
  ch: ClickHouseClient,
  providers: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const p of new Set(providers)) {
    const rows = await queryRows<{ t: string | null }>(
      ch,
      `SELECT formatDateTime(newest_event_time, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS t FROM source_watermarks FINAL WHERE provider_id = {p:String}`,
      { p },
    );
    out[p] = rows[0]?.t ?? null;
  }
  return out;
}

const KNOWN_TABLES = new Set<string>(FACT_TABLES);

/** Per-dataset row-rate estimate for the cost gate: rows / covered-day (count() on the table, covered days from coverage). */
export async function rowsPerDay(ch: ClickHouseClient, sources: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of new Set(sources)) {
    const { provider, dataset } = splitSource(s);
    if (!KNOWN_TABLES.has(dataset)) {
      out[s] = 1;
      continue;
    }
    const total = await queryRows<{ n: string }>(ch, `SELECT toString(count()) AS n FROM ${dataset}`);
    const days = await queryRows<{ n: string }>(
      ch,
      `SELECT toString(uniqExact(day)) AS n FROM source_coverage FINAL WHERE provider_id = {p:String} AND dataset = {d:String}`,
      { p: provider, d: dataset },
    );
    out[s] = Math.max(1, Number(total[0]?.n ?? 0) / Math.max(1, Number(days[0]?.n ?? 0)));
  }
  return out;
}

/** Source vintage: versions of the fact tables and coverage rows a query depends on (changes when any dependency is re-delivered or updated). */
export async function sourceVintage(ch: ClickHouseClient, sources: string[]): Promise<string> {
  const parts: Record<string, string> = {};
  for (const s of [...new Set(sources)].sort()) {
    const { provider, dataset } = splitSource(s);
    const t = KNOWN_TABLES.has(dataset)
      ? await queryRows<{ v: string }>(ch, `SELECT toString(max(version)) AS v FROM ${dataset}`)
      : [{ v: "0" }];
    const c = await queryRows<{ v: string }>(
      ch,
      `SELECT toString(max(version)) AS v FROM source_coverage WHERE provider_id = {p:String} AND dataset = {d:String}`,
      { p: provider, d: dataset },
    );
    parts[s] = `${t[0]?.v ?? "0"}/${c[0]?.v ?? "0"}`;
  }
  return createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 16);
}
