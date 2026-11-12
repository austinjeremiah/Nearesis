import { createHash, randomUUID } from "node:crypto";
import {
  CubeError,
  canonicalJson,
  createCh,
  cubeLoad,
  saveQuery,
  signCubeToken,
  CUBES,
  type Registry,
} from "@nearesis/analytics";
import type { DataFrameEnvelope, RollupFreshness } from "@nearesis/contracts";
import { buildCacheKey } from "./cache.ts";
import {
  loadCoverage,
  loadQualityGaps,
  loadWatermarks,
  rowRates,
  sourceVintage,
  type CoverageMap,
  type CoverageState,
} from "./coverage.ts";
import { fail } from "./errors.ts";
import {
  applyRollupRates,
  inspectRollups,
  rollupRates,
  type RollupInspection,
  type RollupRate,
} from "./rollup.ts";
import { ReadCache } from "./read-cache.ts";
import { DAY_MS, bucketStart, cubeTime, daysBetween, isoDay, nextBucket, type Grain } from "./time.ts";
import { validateQuery, INDEX_UNIT, SAFE_FILTER_VALUE, type Plan } from "./validate.ts";
import type {
  AuditRecord,
  CatalogResult,
  GatewayOptions,
  GatewayStats,
  Policy,
  QueryResult,
  Session,
} from "./types.ts";

const OPS: Record<string, string> = {
  equals: "equals",
  in: "equals",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
};

const DOMAIN_MAX = 10_000;
const DOMAIN_TTL_MS = 30_000;
const domainMemo = new Map<string, { at: number; values: Set<string> | null }>();

/**
 * Filter values outside the conservative charset (legitimate punctuation such as brackets or quotes in an asset label)
 * are passed on only if they exist verbatim in the dimension's stored domain. The domain is read WITHOUT any caller
 * value in the statement (ClickHouse logs bound parameters into its statement log, so even a typed parameter would put
 * the caller's text in a database log) and membership is decided in process. A dimension with more than DOMAIN_MAX
 * distinct values cannot be verified, so its punctuated values are refused (fail closed).
 * Returns the path of the first unverifiable value, or undefined.
 */
export async function verifyPunctuatedValues(
  ch: ReturnType<typeof createCh>,
  filters: { member: string; values: unknown[] }[],
  now: () => number = Date.now,
): Promise<string | undefined> {
  for (const [i, f] of filters.entries()) {
    const odd = f.values.filter((x): x is string => typeof x === "string" && !SAFE_FILTER_VALUE.test(x));
    if (odd.length === 0) continue;
    const [view, name] = f.member.split(".");
    const cube = CUBES.find((c) => c.view === view);
    const dim = cube?.dimensions.find((d) => d.name === name);
    if (!cube || !dim) return `filters[${i}].member`;
    const memoKey = `${cube.table}.${dim.name}`;
    let entry = domainMemo.get(memoKey);
    if (!entry || now() - entry.at > DOMAIN_TTL_MS) {
      const rows = await (
        await ch.query({
          query: `SELECT DISTINCT toString(${dim.sql}) AS v FROM ${cube.table} FINAL LIMIT ${DOMAIN_MAX + 1}`,
          format: "JSONEachRow",
        })
      ).json<{ v: string }>();
      entry = { at: now(), values: rows.length > DOMAIN_MAX ? null : new Set(rows.map((r) => r.v)) };
      domainMemo.set(memoKey, entry);
    }
    const known = entry.values;
    const j = f.values.findIndex(
      (x) => typeof x === "string" && !SAFE_FILTER_VALUE.test(x) && !(known?.has(x) ?? false),
    );
    if (j >= 0) return `filters[${i}].values[${j}]`;
  }
  return undefined;
}

export function queryHashOf(ast: unknown): string {
  return createHash("sha256").update(canonicalJson(ast)).digest("hex");
}

/** Pure cost estimate: rows/day per dataset x days in window. */
export function estimateRows(perDay: Record<string, number>, days: number): number {
  return Math.ceil(Object.values(perDay).reduce((a, b) => a + b, 0) * days);
}

/** Normalizes an exact decimal string to its declared scale (ClickHouse trims trailing zeros). String-only: no float path. */
export function formatScale(v: string, scale: number): string {
  const neg = v.startsWith("-");
  const [i = "0", f = ""] = (neg ? v.slice(1) : v).split(".");
  const frac = f.padEnd(scale, "0").slice(0, scale);
  return `${neg ? "-" : ""}${i}${scale > 0 ? `.${frac}` : ""}`;
}

/** How long a result labelled stale may be served from the gateway cache. */
const STALE_CACHE_TTL_SECONDS = 2;
const zeroOf = (scale: number) => (scale > 0 ? `0.${"0".repeat(scale)}` : "0");
const ZERO_FILLABLE = new Set(["sum", "count_distinct", "non_additive"]);

/** The Cube query for a validated plan (also used, without executing, to ask Cube which pre-aggregation would serve it). */
function makeCubeQuery(
  plan: Plan,
  ast: Plan["ast"],
  fromMs: number,
  toMs: number,
  metricById?: Map<string, { cubeMember: string }>,
) {
  return {
    measures: plan.metrics.map((m) => m.cubeMember),
    dimensions: plan.dimensions.map((d) => d.id),
    timeDimensions: [
      {
        dimension: `${plan.view}.day`,
        granularity: ast.time.grain,
        dateRange: [cubeTime(fromMs), cubeTime(toMs - 1)],
      },
    ],
    filters: ast.filters.map((f) => ({
      member: f.member,
      operator: OPS[f.operator]!,
      values: f.values.map(String),
    })),
    order: ast.order.length
      ? ast.order.map((o) => [
          metricById?.get(o.member)?.cubeMember ??
            (o.member === ast.time.field ? `${plan.view}.day` : o.member),
          o.direction,
        ])
      : [[`${plan.view}.day`, "asc"]],
    // One extra row tells the gateway that the limit cut the result, so it can say so (ResultTruncation).
    limit: ast.limit + 1,
    timezone: "UTC",
  };
}

export function createGateway(opts: GatewayOptions) {
  const ch = opts.ch ?? createCh();
  const reg: Registry = opts.registry;
  const stats: GatewayStats = { executions: 0, cacheHits: 0, cacheMisses: 0, rejected: 0, coverageProbes: 0 };
  const audit: AuditRecord[] = [];
  const reads = new ReadCache(opts.readCacheMs ?? 5000);
  // Row rates need `count() FINAL` over a whole fact table (seconds at live volume) and move slowly: cache longer than the other reads.
  const rates = new ReadCache(opts.rowRateCacheMs ?? (opts.readCacheMs === 0 ? 0 : 60_000));
  const srcKey = (xs: string[]) => [...new Set(xs)].sort().join("|");
  const metricById = new Map(reg.metrics.map((m) => [m.id, m]));

  // Rollups are built on first use (no refresh worker): a query that would be served from an unbuilt or stale rollup
  // starts a one-day, one-row load of the same shape so the build happens, at most once a minute per rollup.
  const warmedAt = new Map<string, number>();
  const warm = (session: Session, plan: Plan, ast: Plan["ast"], toMs: number, id: string) => {
    const t = opts.clock().getTime();
    if (t - (warmedAt.get(id) ?? 0) < 60_000) return;
    warmedAt.set(id, t);
    const q = makeCubeQuery(plan, ast, toMs - DAY_MS, toMs, metricById);
    void cubeLoad(opts.cubeUrl, signCubeToken(opts.cubeSecret, ctxOf(session)), {
      ...q,
      limit: 1,
      cache: "must-revalidate",
    }).catch(() => undefined);
  };

  const record = (a: Omit<AuditRecord, "at">) => audit.push({ at: opts.clock().toISOString(), ...a });
  const ctxOf = (s: Session) => ({
    tenantId: s.tenantId,
    workspaceId: s.workspaceId,
    principalId: s.principalId,
    aclClasses: [...s.aclClasses],
  });

  const persist = async (queryHash: string, ast: unknown) => {
    if (opts.pg)
      await saveQuery(opts.pg, {
        queryHash,
        ast,
        semanticVersion: reg.semanticVersion,
        semanticModelHash: reg.contentHash,
      });
  };

  async function query(session: Session, input: unknown): Promise<QueryResult> {
    const traceId = randomUUID();
    const rejectAudit = (r: QueryResult) => {
      stats.rejected++;
      record({
        traceId,
        queryHash: "",
        principalId: session.principalId,
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        boundContext: ctxOf(session),
        outcome: "rejected",
        reasonCode: r.ok ? undefined : r.error.reasonCode,
      });
      return r;
    };
    try {
      const policy: Policy = await opts.policyResolver(session);
      const v = validateQuery(input, policy, reg);
      if (!v.ok) return rejectAudit(v);
      const plan = v.plan;
      const ast = plan.ast;
      const unknownValue = await verifyPunctuatedValues(ch, ast.filters);
      if (unknownValue)
        return rejectAudit(
          fail("VALIDATION_FAILED", "INVALID_VALUE", "Filter value is not a known value of the dimension.", {
            details: [{ path: unknownValue, issue: "INVALID_VALUE" }],
          }),
        );
      const fromMs = Date.parse(ast.time.from);
      const toMs = Date.parse(ast.time.to);
      const sources = [...new Set(plan.metrics.flatMap((m) => m.sources))];

      // Cost gate before any Cube/ClickHouse fact load (S06).
      stats.coverageProbes++;
      const { perDay, unknown: unknownCoverage } = await rates.get(`rpd:${srcKey(sources)}`, () =>
        rowRates(ch, sources),
      );
      if (unknownCoverage.length)
        return rejectAudit(
          fail(
            "BUDGET_EXCEEDED",
            "COVERAGE_UNKNOWN",
            `Row volume cannot be estimated: no loaded coverage for ${unknownCoverage.join(", ")}.`,
            {
              details: [{ path: "time", issue: "COVERAGE_UNKNOWN" }],
              nextAction: "Load the source (coverage rows) before querying it.",
            },
          ),
        );
      // Rollup-aware: a query fully covered by a BUILT, FRESH pre-aggregation scans the rollup, not the fact table.
      // Unbuilt, stale, unreachable or unmatched all fall back to the raw rate (never an under-estimate).
      const days = (toMs - fromMs) / DAY_MS;
      let rollups: RollupRate[] = [];
      if (opts.rollupAwareCost !== false) {
        const shape = makeCubeQuery(plan, ast, fromMs, toMs, metricById);
        const dateless = {
          ...shape,
          timeDimensions: shape.timeDimensions.map(({ dateRange: _d, ...t }) => t),
        };
        rollups = await rates
          .get(`rollup:${queryHashOf(dateless)}`, () =>
            rollupRates(ch, opts.cubeUrl, signCubeToken(opts.cubeSecret, ctxOf(session)), shape),
          )
          .catch(() => []);
      }
      const { perDay: costRates, served, notReady } = applyRollupRates(perDay, rollups);
      const est = estimateRows(costRates, days);
      if (served.length) stats.rollupEstimates = (stats.rollupEstimates ?? 0) + 1;
      if (notReady.length && opts.warmRollups !== false)
        for (const r of notReady) warm(session, plan, ast, toMs, r.preAggregationId);
      if (est > policy.maxEstimatedRows)
        return rejectAudit(
          fail(
            "BUDGET_EXCEEDED",
            "COST_CAP",
            `Estimated ${est} rows exceeds the cap of ${policy.maxEstimatedRows}.`,
            {
              details: [{ path: "time", issue: "COST_CAP" }],
              nextAction: notReady.length
                ? "Narrow the date range or reduce measures. A covering pre-aggregation is not built or is stale; it is being refreshed, retry shortly."
                : "Narrow the date range or reduce measures.",
            },
          ),
        );

      const fromDay = isoDay(fromMs);
      const toDay = isoDay(toMs - 1);
      const coverage = await reads.get(`cov:${srcKey(sources)}:${fromDay}:${toDay}`, () =>
        loadCoverage(ch, sources, fromDay, toDay),
      );
      const gapsRaw = await reads.get(`gap:${srcKey(sources)}:${ast.time.from}:${ast.time.to}`, () =>
        loadQualityGaps(ch, sources, ast.time.from, ast.time.to),
      );
      const watermarks = await reads.get(`wm:${srcKey(sources)}`, () =>
        loadWatermarks(
          ch,
          sources.map((s) => s.slice(0, s.indexOf(":"))),
        ),
      );

      // Refuse before executing when policy says incomplete windows are refused.
      if (policy.incompleteWindow === "refuse" && (ast.time.grain === "week" || ast.time.grain === "month")) {
        const excl = excludedDays(plan, coverage, fromMs, toMs, new Set());
        if (excl.length)
          return rejectAudit(
            fail(
              "DOMAIN_INVARIANT",
              "INCOMPLETE_WINDOW",
              `Window contains ${excl.length} unavailable day(s): ${excl.slice(0, 10).join(", ")}.`,
              {
                details: [{ path: "time", issue: "INCOMPLETE_WINDOW" }],
                nextAction: "Query at day grain or choose a complete window.",
              },
            ),
          );
      }

      const queryHash = queryHashOf(ast);
      const vintage = await reads.get(`vin:${srcKey(sources)}`, () => sourceVintage(ch, sources));
      const cacheKey = buildCacheKey({
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        aclClasses: session.aclClasses,
        semanticVersion: reg.semanticVersion,
        semanticModelHash: reg.contentHash,
        sourceVintage: vintage,
        queryHash,
      });
      const hit = await opts.redis.get(cacheKey);
      if (hit) {
        stats.cacheHits++;
        await persist(queryHash, ast);
        record({
          traceId,
          queryHash,
          principalId: session.principalId,
          tenantId: session.tenantId,
          workspaceId: session.workspaceId,
          boundContext: ctxOf(session),
          outcome: "cache_hit",
        });
        return {
          ok: true,
          status: 200,
          queryHash,
          cache: "hit",
          cacheKey,
          envelope: JSON.parse(hit) as DataFrameEnvelope,
        };
      }
      stats.cacheMisses++;

      const cubeQuery = {
        ...makeCubeQuery(plan, ast, fromMs, toMs, metricById),
        cache: "must-revalidate" as const,
      };

      const boundContext = ctxOf(session);
      const token = signCubeToken(opts.cubeSecret, boundContext);
      stats.executions++;
      record({
        traceId,
        queryHash,
        principalId: session.principalId,
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        boundContext,
        outcome: "executed",
      });
      let res;
      try {
        res = await cubeLoad(opts.cubeUrl, token, cubeQuery);
      } catch (e) {
        if (e instanceof CubeError || e instanceof TypeError)
          return fail("UPSTREAM_DEGRADED", "CUBE_UNAVAILABLE", "Semantic engine unavailable.", {
            retryable: true,
          });
        throw e;
      }

      // Build vintage of the rollup that served this result versus the source watermark (read uncached, after the load).
      const rollupFreshness = summariseRollupFreshness(
        await inspectRollups(
          ch,
          opts.cubeUrl,
          token,
          makeCubeQuery(plan, ast, fromMs, toMs, metricById),
        ).catch(() => null),
      );
      const env = buildEnvelope({
        rollupFreshness,
        plan,
        reg,
        policy,
        data: res.data,
        coverage,
        gapsRaw,
        watermarks,
        fromMs,
        toMs,
        queryHash,
        planFingerprint: createHash("sha256").update(canonicalJson(cubeQuery)).digest("hex"),
        generatedAt: opts.clock().toISOString(),
        estRows: est,
      });
      await persist(queryHash, ast);
      // A result served from a lagging rollup (labelled stale) is cached for seconds only: the cache key is the source vintage,
      // which does not change when the rollup catches up, so a full-TTL entry would keep the stale label long after.
      const ttl =
        env.certification === "stale"
          ? Math.min(policy.cacheTtlSeconds, STALE_CACHE_TTL_SECONDS)
          : policy.cacheTtlSeconds;
      await opts.redis.set(cacheKey, JSON.stringify(env), "EX", ttl);
      return { ok: true, status: 200, queryHash, cache: "miss", cacheKey, envelope: env };
    } catch (e) {
      return fail("INTERNAL", "INTERNAL", `Internal error: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  async function discover(session: Session): Promise<CatalogResult> {
    const policy = await opts.policyResolver(session);
    const g = new Set(policy.grantedMembers);
    return {
      semanticVersion: reg.semanticVersion,
      semanticModelHash: reg.contentHash,
      metrics: reg.metrics.filter((m) => m.certified && (m.visibility !== "restricted" || g.has(m.id))),
      dimensions: reg.dimensions.filter((d) => d.visibility !== "restricted" || g.has(d.id)),
    };
  }

  return {
    query,
    discover,

    stats: () => ({ ...stats }),
    audit: () => audit.map((a) => ({ ...a })),
  };
}

/** Days with no available data for any selected source (explicit unavailable, or missing record with no data). */
function excludedDays(
  plan: Plan,
  coverage: CoverageMap,
  fromMs: number,
  toMs: number,
  dataDays: Set<string>,
): string[] {
  const out = new Set<string>();
  for (const d of daysBetween(fromMs, toMs)) {
    for (const m of plan.metrics) {
      const all = m.sources.map(
        (s) => coverage.get(s)?.get(d)?.state ?? (dataDays.has(d) ? "partial" : "unavailable"),
      );
      if (all.every((x) => x === "unavailable")) out.add(d);
    }
  }
  return [...out].sort();
}

interface BuildArgs {
  plan: Plan;
  reg: Registry;
  policy: Policy;
  data: Array<Record<string, string | number | null>>;
  coverage: CoverageMap;
  gapsRaw: Awaited<ReturnType<typeof loadQualityGaps>>;
  watermarks: Record<string, string | null>;
  fromMs: number;
  toMs: number;
  queryHash: string;
  planFingerprint: string;
  generatedAt: string;
  estRows: number;
  rollupFreshness?: RollupFreshness;
}

const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString());

/** null input = vintage unreadable. No covering rollup = the result was computed from the source ("not_used"). */
export function summariseRollupFreshness(insp: RollupInspection[] | null): RollupFreshness {
  if (insp === null)
    return { state: "unknown", rollupBuiltAt: null, sourceChangedAt: null, lagSeconds: null };
  if (!insp.length)
    return { state: "not_used", rollupBuiltAt: null, sourceChangedAt: null, lagSeconds: null };
  // The cost gate treats a rollup built in the same second as the last source write as stale (never an under-estimate). The
  // label is stricter: it says stale only when the rollup is provably older than its source (timestamps have 1 s resolution,
  // so a rollup finished within the same second as the write is not called stale).
  const behind = insp.filter(
    (i) =>
      i.rate.state === "stale" &&
      i.builtAtSec !== null &&
      i.sourceChangedAtSec !== null &&
      i.builtAtSec < i.sourceChangedAtSec,
  );
  if (behind.length) {
    const built = Math.min(...behind.map((i) => i.builtAtSec ?? 0));
    const src = Math.max(...behind.map((i) => i.sourceChangedAtSec ?? 0));
    return {
      state: "stale",
      rollupBuiltAt: iso(built),
      sourceChangedAt: iso(src),
      lagSeconds: Math.max(0, src - built),
    };
  }
  if (insp.some((i) => i.rate.state === "unbuilt"))
    return { state: "unbuilt", rollupBuiltAt: null, sourceChangedAt: null, lagSeconds: null };
  const built = Math.min(...insp.map((i) => i.builtAtSec ?? 0));
  const src = Math.max(...insp.map((i) => i.sourceChangedAtSec ?? 0));
  return { state: "fresh", rollupBuiltAt: iso(built), sourceChangedAt: iso(src), lagSeconds: 0 };
}

function worst(states: CoverageState[]): CoverageState {
  if (states.every((s) => s === "complete")) return "complete";
  if (states.every((s) => s === "unavailable")) return "unavailable";
  return "partial";
}

export function buildEnvelope(a: BuildArgs): DataFrameEnvelope {
  const { plan, reg, data, coverage } = a;
  const ast = plan.ast;
  const grain = ast.time.grain as Grain;
  const timeKey = `${plan.view}.day.${grain}`;
  const dimIds = plan.dimensions.map((d) => d.id);
  const scales = reg.exactScales;

  const num = (m: (typeof plan.metrics)[number], v: string | number | null): string | number | null => {
    if (v === null || v === undefined) return null;
    if (scales[m.id] !== undefined) return formatScale(String(v), scales[m.id]!);
    return Number(v);
  };

  // group Cube rows by bucket
  const byBucket = new Map<string, Array<Record<string, string | number | null>>>();
  for (const r of data) {
    const k = String(r[timeKey] ?? r[`${plan.view}.day`]);
    const arr = byBucket.get(k) ?? [];
    arr.push(r);
    byBucket.set(k, arr);
  }
  const dataDays = new Set<string>();
  for (const k of byBucket.keys()) {
    const b = Date.parse(`${k}Z`);
    for (const d of daysBetween(b, nextBucket(b, grain))) dataDays.add(d);
  }

  const gaps: DataFrameEnvelope["gaps"] = [];
  const rows: DataFrameEnvelope["rows"] = [];
  const rowCoverage: CoverageState[] = [];
  let nullCount = 0;

  const bucketMetricState = (m: (typeof plan.metrics)[number], bStart: number, hasData: boolean) => {
    const lo = Math.max(bStart, a.fromMs);
    const hi = Math.min(nextBucket(bStart, grain), a.toMs);
    const days = daysBetween(lo, hi);
    const states: CoverageState[] = [];
    const excluded: Array<{ day: string; reason: string }> = [];
    for (const d of days) {
      const per = m.sources.map((s) => coverage.get(s)?.get(d));
      const st = per.map((c) => c?.state ?? (hasData ? ("partial" as const) : ("unavailable" as const)));
      const s = worst(st);
      states.push(s);
      if (s === "unavailable")
        excluded.push({
          day: d,
          reason: per.find((c) => c?.state === "unavailable")?.reason ?? "NO_COVERAGE_RECORD",
        });
      // a partial day (still filling, cut by a page edge, touched by a gap) is listed too, with its coverage reason
      else if (s === "partial") {
        const why = per.find((c) => c?.state === "partial")?.reason;
        if (why) excluded.push({ day: d, reason: why });
      }
    }
    return { state: worst(states), excluded };
  };

  const noteGaps = (excluded: Array<{ day: string; reason: string }>) => {
    for (const e of excluded) {
      const from = `${e.day}T00:00:00.000Z`;
      const to = new Date(Date.parse(from) + DAY_MS).toISOString();
      const last = gaps.at(-1);
      if (last && last.to === from && last.reason === e.reason) last.to = to;
      else if (!gaps.some((g) => g.from === from)) gaps.push({ from, to, reason: e.reason });
    }
  };

  const emit = (
    timeStr: string,
    bStart: number,
    dimVals: Array<string | number | null>,
    rec: Record<string, string | number | null> | undefined,
    hasData: boolean,
  ) => {
    const states: CoverageState[] = [];
    const cells: Array<string | number | null> = [];
    for (const m of plan.metrics) {
      const { state, excluded } = bucketMetricState(m, bStart, hasData);
      states.push(state);
      noteGaps(excluded);
      let v: string | number | null;
      const raw = rec ? rec[m.cubeMember] : undefined;
      if (state === "unavailable") v = null;
      else if (raw !== undefined && raw !== null) v = num(m, raw);
      else if (rec === undefined && state === "complete" && ZERO_FILLABLE.has(m.aggregationLaw)) {
        // zero-fill only when no bucket record exists; a present NULL (all inputs unknown) stays NULL
        const sc = scales[m.id];
        v = sc !== undefined ? zeroOf(sc) : 0;
      } else v = null;
      if (v === null) nullCount++;
      cells.push(v);
    }
    rows.push([timeStr, ...dimVals, ...cells]);
    rowCoverage.push(worst(states));
  };

  const start = bucketStart(a.fromMs, grain);
  if (dimIds.length === 0) {
    for (let b = start; b < a.toMs; b = nextBucket(b, grain)) {
      const key = cubeTime(b);
      const rec = byBucket.get(key)?.[0];
      emit(`${key}Z`, b, [], rec, !!rec);
    }
  } else {
    for (let b = start; b < a.toMs; b = nextBucket(b, grain)) {
      const key = cubeTime(b);
      const recs = byBucket.get(key) ?? [];
      if (!recs.length) {
        const st = plan.metrics.map((m) => bucketMetricState(m, b, false));
        if (st.every((s) => s.state === "unavailable"))
          emit(
            `${key}Z`,
            b,
            dimIds.map(() => null),
            undefined,
            false,
          );
        continue;
      }
      for (const r of recs)
        emit(
          `${key}Z`,
          b,
          dimIds.map((d) => (r[d] as string | null) ?? null),
          r,
          true,
        );
    }
  }

  // index transform: explicit, declared, first non-null = 100
  if (plan.indexed) {
    const off = 1 + dimIds.length;
    for (let j = 0; j < plan.metrics.length; j++) {
      const base = rows.map((r) => r[off + j]).find((x) => x !== null && Number(x) !== 0);
      for (const r of rows) {
        const v = r[off + j];
        r[off + j] = v === null || base === undefined ? null : (Number(v) / Number(base)) * 100;
      }
    }
  }

  // add quality gaps not already covered
  for (const g of a.gapsRaw) {
    if (g.state !== "unavailable" && g.state !== "partial") continue;
    if (!gaps.some((x) => x.from <= g.from && x.to >= g.to))
      gaps.push({ from: g.from, to: g.to, reason: g.reasonCode });
  }
  gaps.sort((x, y) => x.from.localeCompare(y.from));

  if (ast.order.length && dimIds.length === 0) {
    const idx = (id: string) => (id === ast.time.field ? 0 : 1 + plan.metrics.findIndex((m) => m.id === id));
    const paired = rows.map((r, i) => ({ r, c: rowCoverage[i]! }));
    paired.sort((p, q) => {
      for (const o of ast.order) {
        const i = idx(o.member);
        if (i < 0) continue;
        const x = p.r[i];
        const y = q.r[i];
        const cmp =
          x === y
            ? 0
            : x === null
              ? 1
              : y === null
                ? -1
                : Number(x) < Number(y) ||
                    (typeof x === "string" && typeof y === "string" && Number.isNaN(Number(x)) && x < y)
                  ? -1
                  : 1;
        if (cmp) return o.direction === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    rows.splice(0, rows.length, ...paired.map((p) => p.r));
    rowCoverage.splice(0, rowCoverage.length, ...paired.map((p) => p.c));
  }
  let truncation: DataFrameEnvelope["truncation"];
  if (rows.length > ast.limit) {
    truncation = {
      truncated: true,
      reason: "MAX_ROWS",
      method: "truncate",
      requestedRows: rows.length,
      returnedRows: ast.limit,
      maxRows: ast.limit,
      requestedRowsIsLowerBound: true,
    };
    rows.length = ast.limit;
    rowCoverage.length = ast.limit;
  }

  const partialCount = rowCoverage.filter((c) => c === "partial").length;
  const watermarkStates = a.watermarks;
  const anyUnavail = rowCoverage.some((c) => c !== "complete") || nullCount > 0;
  const experimental = plan.metrics.some((m) => !m.certified);
  const certification: DataFrameEnvelope["certification"] = experimental
    ? "experimental"
    : a.rollupFreshness?.state === "stale"
      ? "stale"
      : anyUnavail
        ? "partial"
        : "certified";

  return {
    queryHash: a.queryHash,
    semanticVersion: reg.semanticVersion,
    semanticModelHash: reg.contentHash,
    sourceSnapshotId: ast.sourceSnapshotId ?? null,
    columns: [
      { name: ast.time.field, type: "time", unit: null },
      ...plan.dimensions.map((d) => ({ name: d.id, type: "string" as const, unit: null })),
      ...plan.metrics.map((m) => {
        const sc = scales[m.id];
        return sc !== undefined && !plan.indexed
          ? { name: m.id, type: "decimal" as const, unit: m.unit, scale: sc }
          : { name: m.id, type: "number" as const, unit: plan.indexed ? INDEX_UNIT : m.unit };
      }),
    ],
    rows,
    rowCoverage,
    nullCount,
    partialCount,
    gaps,
    sourceWatermarks: watermarkStates,
    sources: [...new Set(plan.metrics.flatMap((m) => m.sources.map((x) => x.split(":")[0]!)))].sort(),
    certification,
    cost: { bytesEstimated: a.estRows * 200, bytesBilled: 0 },
    planFingerprint: a.planFingerprint,
    generatedAt: a.generatedAt,
    ...(a.rollupFreshness ? { rollupFreshness: a.rollupFreshness } : {}),
    ...(truncation ? { truncation } : {}),
  };
}
