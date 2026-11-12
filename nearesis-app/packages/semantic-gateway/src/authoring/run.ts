import { EXACT_READ_SETTINGS, FACT_TABLES, queryRows, type ClickHouseClient } from "@nearesis/analytics";
import type { MetricCheck, MetricExpr, MetricIssue } from "@nearesis/contracts";
import { loadCoverage, rowRates, type CoverageMap } from "../coverage.ts";
import type { CompiledPlan, CompiledTable } from "./compiler.ts";
import {
  addDec,
  cmpDec,
  divDec,
  formatDec,
  isZero,
  mulDec,
  parseDec,
  roundDec,
  subDec,
  type Dec,
} from "./decimal.ts";
import { bucketStmt, rawAggStmt, type Stmt } from "./sql.ts";

const DAY_MS = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export type Grain = "day" | "week" | "month";

export function bucketStart(day: string, grain: Grain): string {
  const d = new Date(ms(day));
  if (grain === "day") return day;
  if (grain === "week") return iso(ms(day) - ((d.getUTCDay() + 6) % 7) * DAY_MS);
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
export function nextBucket(bucket: string, grain: Grain): string {
  if (grain === "day") return iso(ms(bucket) + DAY_MS);
  if (grain === "week") return iso(ms(bucket) + 7 * DAY_MS);
  const d = new Date(ms(bucket));
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
export function bucketsIn(from: string, to: string, grain: Grain): string[] {
  const out: string[] = [];
  for (let b = bucketStart(from, grain); b < to; b = nextBucket(b, grain)) if (b >= from) out.push(b);
  return out;
}
/** Whole buckets at both ends: a partial bucket would otherwise look like a complete one. */
export function alignWindow(w: Window, grain: Grain): Window {
  const from = bucketStart(w.from, grain);
  const to = bucketStart(w.to, grain) === w.to ? w.to : nextBucket(bucketStart(w.to, grain), grain);
  return { from, to };
}
export const daysBetween = (from: string, to: string) =>
  Math.max(0, Math.round((ms(to) - ms(from)) / DAY_MS));

export interface Window {
  from: string;
  /** exclusive */
  to: string;
}

export interface RunLimits {
  maxEstimatedRows: number;
  maxExecutionSeconds: number;
  /** Hard ClickHouse cap per statement; exceeding it fails the statement (read_overflow_mode=throw). */
  maxRowsToRead: number;
}

async function runStmt(
  ch: ClickHouseClient,
  s: Stmt,
  lim: RunLimits,
): Promise<Array<Record<string, string | null>>> {
  const rs = await ch.query({
    query: s.sql,
    query_params: s.params,
    format: "JSONEachRow",
    clickhouse_settings: {
      ...EXACT_READ_SETTINGS,
      // readonly=2: SELECT only (no DDL/DML) while still letting this statement set its own bounds.
      readonly: "2",
      max_execution_time: lim.maxExecutionSeconds,
      max_rows_to_read: String(lim.maxRowsToRead),
      read_overflow_mode: "throw",
      max_result_rows: "100000",
      result_overflow_mode: "throw",
    },
  });
  return (await rs.json()) as Array<Record<string, string | null>>;
}

// ---------------------------------------------------------------- cost
const rateCache = new Map<string, { at: number; perDay: number | null }>();

/** Rows per covered day of a table: the gateway's row-rate formula (current rows FINAL / days with coverage). null = no coverage. */
async function tableRate(ch: ClickHouseClient, t: CompiledTable): Promise<number | null> {
  if (!t.provider || !t.coverageDataset) return null;
  const key = `${t.database}.${t.table}`;
  const hit = rateCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.perDay;
  let perDay: number | null;
  if ((FACT_TABLES as readonly string[]).includes(t.table)) {
    const r = await rowRates(ch, [`${t.provider}:${t.coverageDataset}`]);
    perDay = r.unknown.length ? null : (r.perDay[`${t.provider}:${t.coverageDataset}`] ?? null);
  } else {
    const days = await queryRows<{ n: string }>(
      ch,
      `SELECT toString(uniqExact(day)) AS n FROM source_coverage FINAL
       WHERE provider_id = {p:String} AND dataset = {d:String} AND state IN ('complete', 'partial')`,
      { p: t.provider, d: t.coverageDataset },
    );
    const n = Number(days[0]?.n ?? 0);
    if (n === 0) perDay = null;
    else {
      const total = await queryRows<{ n: string }>(
        ch,
        `SELECT toString(count()) AS n FROM \`${t.database}\`.\`${t.table}\`${t.final ? " FINAL" : ""}`,
      );
      perDay = Math.max(1, Number(total[0]?.n ?? 0) / n);
    }
  }
  rateCache.set(key, { at: Date.now(), perDay });
  return perDay;
}

export async function estimateCost(
  ch: ClickHouseClient,
  plan: CompiledPlan,
  windowDays: number,
): Promise<{ estimatedRows: number; unknown: string[] }> {
  let rows = 0;
  const unknown: string[] = [];
  for (const t of plan.tables) {
    const r = await tableRate(ch, t);
    if (r === null) unknown.push(t.table);
    else rows += r * windowDays;
  }
  return { estimatedRows: Math.ceil(rows), unknown };
}

// ---------------------------------------------------------------- windows and coverage
/** Latest day with loaded coverage for each table; the sample window ends at the earliest of them. */
export async function latestCoveredDay(ch: ClickHouseClient, plan: CompiledPlan): Promise<string | null> {
  let end = null as string | null;
  for (const t of plan.tables) {
    if (!t.provider || !t.coverageDataset) return null;
    const r = await queryRows<{ d: string | null }>(
      ch,
      `SELECT toString(max(day)) AS d FROM source_coverage FINAL
       WHERE provider_id = {p:String} AND dataset = {d:String} AND state IN ('complete','partial')`,
      { p: t.provider, d: t.coverageDataset },
    );
    const d = r[0]?.d;
    if (!d || d === "1970-01-01") return null;
    end = end === null || d < end ? d : end;
  }
  return end;
}

const SAMPLE_DAYS: Record<Grain, number> = { day: 14, week: 35, month: 95 };

/** Window of whole buckets ending at the last fully covered bucket, about `SAMPLE_DAYS` long. */
export function sampleWindow(endDay: string, grain: Grain): Window {
  const nextDay = iso(ms(endDay) + DAY_MS);
  let to = bucketStart(nextDay, grain) === nextDay ? nextDay : bucketStart(endDay, grain);
  let from = bucketStart(iso(ms(to) - SAMPLE_DAYS[grain] * DAY_MS), grain);
  if (from >= to) {
    // fewer than one whole bucket of data: use the partial bucket rather than nothing
    to = nextDay;
    from = bucketStart(endDay, grain);
  }
  return { from, to };
}

export type BucketCoverage = "complete" | "partial" | "unavailable";

export async function bucketCoverages(
  ch: ClickHouseClient,
  plan: CompiledPlan,
  win: Window,
): Promise<{
  byBucket: Map<string, BucketCoverage>;
  gaps: Array<{ from: string; to: string; reason: string }>;
}> {
  const grain = plan.proposal.timeGrain.grain;
  const sources = plan.tables
    .filter((t) => t.provider && t.coverageDataset)
    .map((t) => `${t.provider}:${t.coverageDataset}`);
  const lastDay = iso(ms(win.to) - DAY_MS);
  const cov: CoverageMap = await loadCoverage(ch, sources, win.from, lastDay);
  const byBucket = new Map<string, BucketCoverage>();
  const gaps: Array<{ from: string; to: string; reason: string }> = [];
  for (const b of bucketsIn(win.from, win.to, grain)) {
    const end = nextBucket(b, grain) < win.to ? nextBucket(b, grain) : win.to;
    let complete = 0;
    let any = 0;
    let total = 0;
    for (let d = b; d < end; d = iso(ms(d) + DAY_MS)) {
      for (const s of sources) {
        total++;
        const st = cov.get(s)?.get(d)?.state;
        if (st === "complete") complete++;
        if (st === "complete" || st === "partial") any++;
        else
          gaps.push({
            from: `${d}T00:00:00.000Z`,
            to: `${iso(ms(d) + DAY_MS)}T00:00:00.000Z`,
            reason: `${s} coverage ${st ?? "unknown"}`,
          });
      }
    }
    byBucket.set(b, total > 0 && complete === total ? "complete" : any > 0 ? "partial" : "unavailable");
  }
  return { byBucket, gaps };
}

// ---------------------------------------------------------------- execution
export interface Series {
  columns: string[];
  rows: Array<{ bucket: string; dims: string[]; value: string | null; coverage: BucketCoverage }>;
  /** per aggregation id: `${bucket}\u0000${dims}` -> value string | null (kept for reconciliation) */
  aggValues: Map<string, Map<string, string | null>>;
  statements: number;
}

const dk = (bucket: string, dims: string[]) => [bucket, ...dims].join("\u0000");

export function evalFormula(e: MetricExpr, v: Map<string, Dec | null>, decimals: number): Dec | null {
  const guard = decimals + 12;
  const go = (x: MetricExpr): Dec | null => {
    switch (x.kind) {
      case "agg":
        return v.get(x.id) ?? null;
      case "const":
        return parseDec(String(x.value));
      case "op": {
        const l = go(x.left);
        const r = go(x.right);
        if (!l || !r) return null;
        if (x.op === "add") return addDec(l, r);
        if (x.op === "sub") return subDec(l, r);
        if (x.op === "mul") return mulDec(l, r);
        return isZero(r) ? null : divDec(l, r, guard);
      }
    }
  };
  const out = go(e);
  return out ? roundDec(out, decimals, "half_even") : null;
}

export function finalize(plan: CompiledPlan, d: Dec | null): string | null {
  if (!d) return null;
  const p = plan.proposal.precision;
  return formatDec(
    p.rounding === "truncate" ? roundDec(d, p.decimals, "truncate") : roundDec(d, p.decimals, "half_even"),
    p.decimals,
  );
}

export async function executePlan(
  ch: ClickHouseClient,
  plan: CompiledPlan,
  win: Window,
  lim: RunLimits,
): Promise<Series> {
  const p = plan.proposal;
  const grain = p.timeGrain.grain;
  const propagate = p.nullSemantics.nullInput === "propagate";
  const aggValues = new Map<string, Map<string, string | null>>();
  let statements = 0;
  const decimals = p.precision.decimals;
  for (const t of plan.tables) {
    const rows = await runStmt(ch, bucketStmt(t, grain, propagate, win), lim);
    statements++;
    for (const a of t.aggs) {
      const m = new Map<string, string | null>();
      for (const r of rows) {
        const dims = t.dims.map((_, i) => String(r[`d${i}`]));
        m.set(dk(String(r.bucket), dims), r[`a_${a.id}`] ?? null);
      }
      aggValues.set(a.id, m);
    }
  }
  const { byBucket } = await bucketCoverages(ch, plan, win);
  const out: Series["rows"] = [];
  const hasDims = p.dimensions.length > 0;
  const keys: Array<{ bucket: string; dims: string[] }> = [];
  if (hasDims) {
    const seen = new Set<string>();
    for (const m of aggValues.values())
      for (const k of m.keys())
        if (!seen.has(k)) {
          seen.add(k);
          keys.push({ bucket: k.split("\u0000")[0] as string, dims: k.split("\u0000").slice(1) });
        }
    keys.sort((a, b) => (a.bucket + a.dims.join()).localeCompare(b.bucket + b.dims.join()));
  } else for (const b of bucketsIn(win.from, win.to, grain)) keys.push({ bucket: b, dims: [] });
  for (const k of keys) {
    const cov = byBucket.get(k.bucket) ?? "unavailable";
    const vals = new Map<string, Dec | null>();
    for (const a of p.aggregations) {
      const raw = aggValues.get(a.id)?.get(dk(k.bucket, k.dims));
      if (raw === undefined) {
        // no source row for this bucket: NULL, or an observed zero only where the author asked for it AND coverage is complete
        vals.set(
          a.id,
          p.nullSemantics.emptyBucket === "zero_when_coverage_complete" && cov === "complete"
            ? parseDec("0")
            : null,
        );
      } else vals.set(a.id, raw === null ? null : parseDec(raw));
    }
    out.push({
      bucket: k.bucket,
      dims: k.dims,
      value: finalize(plan, evalFormula(plan.formula, vals, decimals)),
      coverage: cov,
    });
  }
  return {
    columns: ["bucket", ...p.dimensions.map((d) => d.column), "value"],
    rows: out,
    aggValues,
    statements,
  };
}

// ---------------------------------------------------------------- reconciliation
export interface ReconResult {
  ok: boolean;
  details: string[];
  failures: string[];
}

/**
 * Reconciles a compiled result against raw tables with statements that do not group:
 *  - sum/count/min/max: the combination of the bucket values equals one whole-window raw aggregate;
 *  - every aggregation, and the formula, at up to three buckets: single-bucket raw aggregates equal the bucket value.
 */
export async function reconcile(
  ch: ClickHouseClient,
  plan: CompiledPlan,
  win: Window,
  series: Series,
  lim: RunLimits,
): Promise<ReconResult> {
  const p = plan.proposal;
  const grain = p.timeGrain.grain;
  const propagate = p.nullSemantics.nullInput === "propagate";
  const details: string[] = [];
  const failures: string[] = [];
  const same = (a: string | null, b: string | null) => {
    if (a === null || b === null) return a === b;
    return cmpDec(parseDec(a), parseDec(b)) === 0;
  };
  for (const t of plan.tables) {
    for (const a of t.aggs) {
      if (a.fn === "avg" || a.fn === "count_distinct") continue;
      const buckets = series.aggValues.get(a.id) ?? new Map<string, string | null>();
      const vals = [...buckets.values()].filter((x): x is string => x !== null).map(parseDec);
      let combined: Dec | null = null;
      for (const v of vals)
        combined =
          combined === null
            ? v
            : a.fn === "min"
              ? cmpDec(v, combined) < 0
                ? v
                : combined
              : a.fn === "max"
                ? cmpDec(v, combined) > 0
                  ? v
                  : combined
                : addDec(combined, v);
      const raw = (await runStmt(ch, rawAggStmt(t, a, propagate, win), lim))[0]?.v ?? null;
      // a whole-window sum with no rows is 0 / NULL depending on the aggregate; both mean "nothing observed"
      const rawNorm =
        raw !== null && combined === null && cmpDec(parseDec(raw), parseDec("0")) === 0 ? null : raw;
      const got = combined === null ? null : formatDec(combined);
      const ok =
        same(got, rawNorm) ||
        (got !== null && rawNorm !== null && cmpDec(parseDec(got), parseDec(rawNorm)) === 0);
      (ok ? details : failures).push(`${t.table}.${a.id} (${a.fn}) buckets=${got} raw=${rawNorm}`);
    }
  }
  if (p.dimensions.length === 0) {
    const have = series.rows.filter((r) => r.value !== null);
    const picks = [
      ...new Set([have[0], have[Math.floor(have.length / 2)], have[have.length - 1]].filter(Boolean)),
    ] as typeof have;
    for (const r of picks) {
      const bw: Window = {
        from: r.bucket,
        to: nextBucket(r.bucket, grain) < win.to ? nextBucket(r.bucket, grain) : win.to,
      };
      const vals = new Map<string, Dec | null>();
      for (const t of plan.tables)
        for (const a of t.aggs) {
          const raw = (await runStmt(ch, rawAggStmt(t, a, propagate, bw), lim))[0]?.v ?? null;
          const seriesHas = series.aggValues.get(a.id)?.has(dk(r.bucket, []));
          vals.set(
            a.id,
            raw === null ||
              (!seriesHas &&
                p.nullSemantics.emptyBucket === "null" &&
                (a.fn === "count" || a.fn === "sum") &&
                cmpDec(parseDec(raw), parseDec("0")) === 0)
              ? null
              : parseDec(raw),
          );
        }
      const expect = finalize(plan, evalFormula(plan.formula, vals, p.precision.decimals));
      (same(expect, r.value) ? details : failures).push(
        `bucket ${r.bucket} formula=${r.value} raw=${expect}`,
      );
    }
  } else
    details.push("per-bucket spot check skipped for dimensioned metrics; whole-window additive checks ran");
  return { ok: failures.length === 0, details, failures };
}

// ---------------------------------------------------------------- declared tests
export function runDeclaredTests(
  plan: CompiledPlan,
  series: Series,
): { checks: MetricCheck[]; issues: MetricIssue[] } {
  const checks: MetricCheck[] = [];
  const issues: MetricIssue[] = [];
  for (const [i, t] of plan.proposal.tests.entries()) {
    if (t.kind === "reconcile_raw") {
      checks.push({
        name: `test:${t.name}`,
        verdict: "pass",
        detail: "covered by the mandatory raw reconciliation",
      });
      continue;
    }
    let ok: boolean;
    let detail: string;
    if (t.kind === "expected_value") {
      const row = series.rows.find((r) => r.bucket === t.bucket);
      if (!row || row.value === null) {
        ok = false;
        detail = `no value at ${t.bucket}`;
      } else {
        const diff = subDec(parseDec(row.value), parseDec(t.value));
        const abs = diff.n < 0n ? { n: -diff.n, s: diff.s } : diff;
        ok = cmpDec(abs, parseDec(t.tolerance)) <= 0;
        detail = `value ${row.value}, expected ${t.value} +/- ${t.tolerance}`;
      }
    } else if (t.kind === "non_negative") {
      const bad = series.rows.find((r) => r.value !== null && r.value.startsWith("-"));
      ok = !bad;
      detail = bad ? `negative value at ${bad.bucket}` : "no negative values";
    } else {
      ok = series.rows.filter((r) => r.value !== null).length >= t.rows;
      detail = `${series.rows.filter((r) => r.value !== null).length} non-null rows, need ${t.rows}`;
    }
    checks.push({ name: `test:${t.name}`, verdict: ok ? "pass" : "fail", detail });
    if (!ok) issues.push({ reason: "TEST_FAILED", path: `tests[${i}]`, message: `${t.name}: ${detail}` });
  }
  return { checks, issues };
}
