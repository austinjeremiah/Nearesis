import {
  ANALYTICS_LIMITS,
  INPUT_BY_CAPABILITY,
  type AccountsAnalyzeInput,
  type AnalyticsCapabilityId,
  type AnalyticsOutcome,
  type EntitiesAnalyzeInput,
  type IntentsAnalyzeInput,
} from "@nearesis/contracts";
import { IntentsAnalytics } from "../intents/analytics.ts";
import { add, format, norm, parse, ratio, ZERO } from "../intents/dec.ts";
import { addDays } from "../intents/sql.ts";
import type { IntentsCoverage, IntentsResult } from "../intents/types.ts";
import type { AccountDataSource } from "../accounts/types.ts";
import { ACCOUNT_CAVEATS } from "../accounts/types.ts";
import {
  accountConcentration,
  addDaysIso,
  cohortRetention,
  coverageOf,
  dailyActivity,
  growthContribution,
} from "../accounts/metrics.ts";
import type { EntityDataSource, RegistrySnapshot } from "../entities/types.ts";
import {
  addDays as addDaysE,
  entityChanges,
  entityDaily,
  windowCoverage,
  type Coverage,
} from "../entities/metrics.ts";
import { entitySignerChange, entityUniqueSigners } from "../entities/unique-signers.ts";
import { ACCOUNTS_VERSION, ENTITIES_VERSION, cannot, col, makeTable, ok, type Col } from "./shape.ts";

/**
 * Typed analytics for agents (final_master_prompt s4, s10, s11, s15). Thin, read-only layer over the typed analytics
 * services (A20 intents, A17 entities, A23 accounts): no SQL surface, bounded windows and rows, results carry provenance and
 * coverage, and a source that cannot answer returns the typed CANNOT_COMPUTE outcome instead of a zero.
 * Data here is public reference data of the analytics warehouse: no tenant rows are read, so tenant isolation is the
 * kernel's grant check on the calling principal (the handler never reads tenant or workspace from the input).
 */
export interface AnalyticsDeps {
  intents: IntentsAnalytics;
  entities: EntityDataSource;
  /** Per-signer scan; null = not available (accounts analyses and entity signer counts are then CANNOT_COMPUTE / omitted). */
  accounts: AccountDataSource | null;
  now?: () => Date;
}

export type RunResult =
  | { ok: true; outcome: AnalyticsOutcome }
  | { ok: false; status: 400 | 404 | 503; code: string; message: string };

export class InputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
const span = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
const mondayOf = (d: string): string => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const cap = (xs: string[]): string[] => xs.slice(0, ANALYTICS_LIMITS.maxMissingDaysListed);

function checkRange(from: string, to: string): void {
  if (from > to) throw new InputError("INVALID_WINDOW", `from ${from} is after to ${to}`);
  if (span(from, to) > ANALYTICS_LIMITS.maxWindowDays)
    throw new InputError("INVALID_WINDOW", `window longer than ${ANALYTICS_LIMITS.maxWindowDays} days`);
}

/**
 * Results are cached per (source, capability, parsed input) for 5 minutes and identical concurrent calls share one
 * computation: the same call is made by the composer, by the interpretation stage and by every panel view, and the intents
 * queries scan the swap table (3 to 8 s each on the live database). Only typed outcomes are cached, never refusals or
 * source failures. A window given as `days` ends at the newest complete day, so it moves at most once a day.
 */
const CACHE_TTL_MS = 300_000;
const CACHE_MAX = 100;
const cache = new Map<string, { at: number; result: Promise<RunResult> }>();
const ids = new WeakMap<object, number>();
let idSeq = 0;
const idOf = (o: object | null): number => (o ? (ids.get(o) ?? (ids.set(o, ++idSeq), idSeq)) : 0);
/** One id per distinct combination of sources, so two data sources never share a cached answer. */
const sourceId = (d: AnalyticsDeps): string => `${idOf(d.intents)}.${idOf(d.entities)}.${idOf(d.accounts)}`;

/** Runs one capability call. Never throws for a source that cannot answer; invalid input is a typed refusal. */
export async function runAnalytics(
  deps: AnalyticsDeps,
  capability: AnalyticsCapabilityId,
  rawInput: unknown,
): Promise<RunResult> {
  const parsed = INPUT_BY_CAPABILITY[capability].safeParse(rawInput);
  if (!parsed.success) return compute(deps, capability, rawInput);
  const key = `${sourceId(deps)}|${capability}|${JSON.stringify(parsed.data, Object.keys(parsed.data).sort())}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const result = compute(deps, capability, rawInput);
  cache.set(key, { at: Date.now(), result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  void result.then((r) => {
    if (!r.ok) cache.delete(key); // failures are retried, not remembered
  });
  return result;
}

async function compute(
  deps: AnalyticsDeps,
  capability: AnalyticsCapabilityId,
  rawInput: unknown,
): Promise<RunResult> {
  const parsed = INPUT_BY_CAPABILITY[capability].safeParse(rawInput);
  if (!parsed.success)
    return {
      ok: false,
      status: 400,
      code: "INVALID_INPUT",
      message: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; "),
    };
  try {
    const outcome =
      capability === "intents.analyze@1"
        ? await runIntents(deps, parsed.data as IntentsAnalyzeInput)
        : capability === "entities.analyze@1"
          ? await runEntities(deps, parsed.data as EntitiesAnalyzeInput)
          : await runAccounts(deps, parsed.data as AccountsAnalyzeInput);
    return { ok: true, outcome };
  } catch (e) {
    if (e instanceof InputError)
      return {
        ok: false,
        status: e.code === "ENTITY_NOT_FOUND" ? 404 : 400,
        code: e.code,
        message: e.message,
      };
    if (e instanceof Error && /window/i.test(e.message))
      return { ok: false, status: 400, code: "INVALID_WINDOW", message: e.message.slice(0, 300) };
    return {
      ok: false,
      status: 503,
      code: "ANALYTICS_SOURCE_UNAVAILABLE",
      message: "The analytics source is unavailable.",
    };
  }
}

/* ---------------------------------------------------------------- intents */

function intentsCoverage(c: IntentsCoverage | null) {
  if (!c)
    return {
      state: "complete" as const,
      daysRequested: null,
      daysWithData: null,
      missingDays: [],
      incompleteDays: [],
      note: null,
    };
  const bad = c.incompleteDays.length + c.missingDays.length;
  const state =
    bad === 0
      ? ("complete" as const)
      : c.completeDays === 0 && c.swapRows === 0
        ? ("unavailable" as const)
        : ("partial" as const);
  return {
    state,
    daysRequested: c.daysInWindow,
    daysWithData: c.daysInWindow - c.missingDays.length,
    missingDays: cap(c.missingDays),
    incompleteDays: cap(c.incompleteDays.map((d) => d.day)),
    note:
      bad === 0
        ? null
        : `${c.missingDays.length} day(s) have no coverage record (unknown, never zero) and ${c.incompleteDays.length} are incomplete; counts for those days are lower bounds.`,
  };
}

async function resolveIntentsWindow(
  a: IntentsAnalytics,
  i: { from?: string | undefined; to?: string | undefined; days?: number | undefined },
): Promise<{ from: string; to: string } | null> {
  if (i.from && i.to) {
    checkRange(i.from, i.to);
    return { from: i.from, to: i.to };
  }
  const d = i.to ? null : await a.defaultWindow(i.days ?? 30);
  const to = i.to ?? d?.to;
  if (!to) return null;
  const from = i.from ?? addDays(to, -((i.days ?? 30) - 1));
  checkRange(from, to);
  return { from, to };
}

const INTENTS_SRC = "nearesis_live (NEAR Intents Explorer API, 1Click transactions)";

async function runIntents(deps: AnalyticsDeps, input: IntentsAnalyzeInput): Promise<AnalyticsOutcome> {
  const a = deps.intents;
  const now = (deps.now ?? (() => new Date()))();
  const capability = "intents.analyze@1" as const;
  const ctx = { capability, analysis: input.analysis, now };
  const noWindow = async (metric: string) =>
    cannot(
      ctx,
      { ...input },
      {
        metric,
        missing: ["a complete day in source coverage"],
        explanation: "No complete day exists in source coverage yet; pass an explicit from and to.",
        evidence: [],
        window: null,
        provenance: {
          source: INTENTS_SRC,
          tables: ["source_coverage"],
          asOf: null,
          metricVersion: "intents-1.0.0",
          method: "coverage lookup",
        },
        coverage: intentsCoverage(null),
        caveats: [],
      },
    );

  if (input.analysis === "unusual_flows") {
    const asOf = input.asOf ?? (await a.defaultWindow(1))?.to;
    if (!asOf) return noWindow("intents.unusual_flows");
    const baselineDays = input.baselineDays ?? 28;
    const recentDays = input.recentDays ?? 7;
    const r = await a.unusualFlows(asOf, { baselineDays, recentDays });
    return fromIntents(ctx, { analysis: "unusual_flows", asOf, baselineDays, recentDays }, r, (d) => {
      const x = d as {
        method: { name: string };
        baselineDaysUsed: number;
        recentDaysUsed: number;
        pairsNotScoreable: number;
        excludedIncompleteDays: string[];
        flagged: Array<{
          pair: string;
          baselineMedianDailySwaps: number;
          anomalies: Array<{
            day: string;
            value: number;
            baselineMedian: number;
            score: number;
            direction: string;
          }>;
        }>;
      };
      const cols: Col[] = [
        col("pair", "category"),
        col("day", "time"),
        col("swaps", "number", "swaps"),
        col("baselineMedian", "number", "swaps"),
        col("score", "number", "score"),
        col("direction", "category"),
      ];
      const rows = x.flagged.flatMap((f) =>
        f.anomalies.map((an) => ({
          pair: f.pair,
          day: an.day,
          swaps: an.value,
          baselineMedian: an.baselineMedian,
          score: an.score,
          direction: an.direction,
        })),
      );
      return {
        table: makeTable(cols, rows),
        chart: { kind: "table", y: [] },
        summary: {
          method: x.method.name,
          baselineDaysUsed: x.baselineDaysUsed,
          recentDaysUsed: x.recentDaysUsed,
          pairsNotScoreable: x.pairsNotScoreable,
          excludedIncompleteDays: x.excludedIncompleteDays.length,
        },
      };
    });
  }

  const w = await resolveIntentsWindow(a, input);
  if (!w) return noWindow(`intents.${input.analysis}`);
  const base = { analysis: input.analysis, from: w.from, to: w.to };

  switch (input.analysis) {
    case "status": {
      const grain = input.grain ?? "none";
      const r = await a.statusDistribution(w, grain === "none" ? "none" : "day");
      return fromIntents(ctx, { ...base, grain }, r, (d) => {
        // USD is a settled volume: only SUCCESS swaps have one. Other statuses are null (not applicable), never 0.
        const rows = (
          d as Array<{
            day?: string;
            status: string;
            swaps: number;
            share: string | null;
            volumeUsdKnown: string | null;
            swapsWithUnknownUsd: number;
          }>
        ).map((r0) => ({ ...r0, settledVolumeUsd: r0.status === "SUCCESS" ? r0.volumeUsdKnown : null }));
        if (grain === "none")
          return {
            table: makeTable(
              [
                col("status", "category"),
                col("swaps", "number", "swaps"),
                col("share", "number", "ratio"),
                col("settledVolumeUsd", "number", "USD"),
                col("swapsWithUnknownUsd", "number", "swaps"),
              ],
              rows,
            ),
            chart: { kind: "bar", x: "status", y: ["swaps"] },
          };
        if (grain === "day")
          return {
            table: makeTable(
              [
                col("day", "time"),
                col("status", "category"),
                col("swaps", "number", "swaps"),
                col("share", "number", "ratio"),
                col("settledVolumeUsd", "number", "USD"),
                col("swapsWithUnknownUsd", "number", "swaps"),
              ],
              rows,
            ),
            chart: { kind: "stacked_bar", x: "day", y: ["swaps"], series: "status" },
          };
        // fold complete daily rows into Monday-start weeks: counts add, shares are recomputed within the week
        const wk = new Map<
          string,
          { week: string; status: string; swaps: number; vol: ReturnType<typeof parse> | null; unk: number }
        >();
        for (const r0 of rows) {
          const week = mondayOf(r0.day as string);
          const k = `${week}|${r0.status}`;
          const e = wk.get(k) ?? { week, status: r0.status, swaps: 0, vol: null, unk: 0 };
          e.swaps += r0.swaps;
          if (r0.settledVolumeUsd !== null) e.vol = add(e.vol ?? ZERO, parse(r0.settledVolumeUsd));
          e.unk += r0.swapsWithUnknownUsd;
          wk.set(k, e);
        }
        const tot = new Map<string, number>();
        for (const e of wk.values()) tot.set(e.week, (tot.get(e.week) ?? 0) + e.swaps);
        const out = [...wk.values()]
          .sort((x, y) => (x.week < y.week ? -1 : x.week > y.week ? 1 : y.swaps - x.swaps))
          .map((e) => ({
            week: e.week,
            status: e.status,
            swaps: e.swaps,
            share: ratio(e.swaps, tot.get(e.week) ?? 0),
            settledVolumeUsd: e.vol === null ? null : norm(format(e.vol)),
            swapsWithUnknownUsd: e.unk,
          }));
        const partial = mondayOf(w.from) !== w.from || addDays(mondayOf(w.to), 6) !== w.to;
        return {
          table: makeTable(
            [
              col("week", "time"),
              col("status", "category"),
              col("swaps", "number", "swaps"),
              col("share", "number", "ratio"),
              col("settledVolumeUsd", "number", "USD"),
              col("swapsWithUnknownUsd", "number", "swaps"),
            ],
            out,
          ),
          chart: { kind: "stacked_bar", x: "week", y: ["swaps"], series: "status" },
          caveats: partial
            ? [
                "The first and/or last week is partial: the window does not start on a Monday or end on a Sunday.",
              ]
            : [],
        };
      });
    }
    case "trend": {
      const g = input.granularity ?? "day";
      const em = input.emphasis ?? "swaps";
      const r = await a.trend(w, g);
      return fromIntents(ctx, { ...base, granularity: g, emphasis: em }, r, (d) => ({
        table: makeTable(
          [
            col("period", "time"),
            col("swaps", "number", "swaps"),
            col("success", "number", "swaps"),
            col("refunded", "number", "swaps"),
            col("refundRate", "number", "ratio"),
            col("volumeUsdKnown", "number", "USD"),
            col("swapsWithUnknownUsd", "number", "swaps"),
            col("daysWithData", "number", "days"),
          ],
          d as Array<Record<string, unknown>>,
        ),
        chart: {
          kind: em === "swaps" ? "line" : "line",
          x: "period",
          y:
            em === "swaps"
              ? ["swaps", "success", "refunded"]
              : em === "refunds"
                ? ["refunded"]
                : em === "refund_rate"
                  ? ["refundRate"]
                  : ["volumeUsdKnown"],
        },
      }));
    }
    case "refund_rates": {
      const by = input.by ?? "chain_pair";
      const minTerminal = input.minTerminal ?? 100;
      const top = input.top ?? 25;
      const r = await a.refundRates(w, by, minTerminal, top);
      return fromIntents(ctx, { ...base, by, minTerminal, top }, r, (d) => ({
        table: makeTable(
          [
            col("pair", "category"),
            col("terminalSwaps", "number", "swaps"),
            col("success", "number", "swaps"),
            col("refunded", "number", "swaps"),
            col("failed", "number", "swaps"),
            col("refundRate", "number", "ratio"),
            col("failedRate", "number", "ratio"),
          ],
          (d as Array<Record<string, unknown>>).map((x) => ({
            ...x,
            pair:
              by === "chain_pair"
                ? `${String(x.originChain)}->${String(x.destinationChain)}`
                : `${String(x.originAsset)}->${String(x.destinationAsset)}`,
          })),
        ),
        chart: { kind: "bar", x: "pair", y: ["refundRate"] },
      }));
    }
    case "refund_causes": {
      const by = input.by ?? "reason";
      const r = await a.refundCauses(w, by);
      return fromIntents(ctx, { ...base, by }, r, (d) => {
        const rows = (d as Array<Record<string, unknown>>).map((x) => ({
          ...x,
          pair: by === "chain_pair" ? `${String(x.originChain)}->${String(x.destinationChain)}` : undefined,
        }));
        const tail = [
          col("reason", "category"),
          col("refunded", "number", "swaps"),
          col("share", "number", "ratio"),
          col("refundedUsd", "number", "USD"),
          col("swapsWithUnknownUsd", "number", "swaps"),
        ];
        if (by === "reason")
          return {
            table: makeTable(tail, rows),
            chart: { kind: "bar" as const, x: "reason", y: ["refunded"] },
          };
        if (by === "chain_pair")
          return {
            table: makeTable([col("pair", "category"), ...tail], rows),
            chart: { kind: "stacked_bar" as const, x: "pair", y: ["refunded"], series: "reason" },
          };
        return {
          table: makeTable([col("period", "time"), ...tail], rows),
          chart: { kind: "stacked_bar" as const, x: "period", y: ["refunded"], series: "reason" },
        };
      });
    }
    case "chain_flows": {
      const view = input.view ?? "matrix";
      const r = await a.chainFlows(w);
      return fromIntents(ctx, { ...base, view }, r, (d) => {
        const x = d as { matrix: Array<Record<string, unknown>>; netFlow: Array<Record<string, unknown>> };
        return view === "net"
          ? {
              table: makeTable(
                [
                  col("chain", "category"),
                  col("outflowUsdKnown", "number", "USD"),
                  col("inflowUsdKnown", "number", "USD"),
                  col("netInflowUsdKnown", "number", "USD"),
                ],
                x.netFlow,
              ),
              chart: { kind: "bar", x: "chain", y: ["netInflowUsdKnown"] },
            }
          : {
              table: makeTable(
                [
                  col("originChain", "category"),
                  col("destinationChain", "category"),
                  col("swaps", "number", "swaps"),
                  col("volumeUsdKnown", "number", "USD"),
                  col("swapsWithUnknownUsd", "number", "swaps"),
                  col("refundRate", "number", "ratio"),
                ],
                x.matrix,
              ),
              chart: { kind: "table", y: [] },
            };
      });
    }
    case "concentration": {
      const dimension = input.dimension ?? "origin_asset";
      const measure = input.measure ?? "volume";
      const top = input.top ?? 10;
      const r = await a.concentrationOf(w, dimension, measure, top);
      return fromIntents(ctx, { ...base, dimension, measure, top }, r, (d) => {
        const x = d as {
          groups: number;
          total: string | null;
          hhi: string | null;
          topNShare: string | null;
          top: Array<{ key: string; value: string; share: string }>;
          excludedSwapsWithUnknownUsd: number;
          settledSwaps: number;
        };
        return {
          table: makeTable(
            [
              col("key", "category"),
              col("value", "number", measure === "volume" ? "USD" : "swaps"),
              col("share", "number", "ratio"),
            ],
            x.top,
          ),
          chart: { kind: "bar", x: "key", y: ["share"] },
          summary: {
            groups: x.groups,
            total: x.total === null ? null : Number(x.total),
            hhi: x.hhi === null ? null : Number(x.hhi),
            topNShare: x.topNShare === null ? null : Number(x.topNShare),
            excludedSwapsWithUnknownUsd: x.excludedSwapsWithUnknownUsd,
            settledSwaps: x.settledSwaps,
          },
        };
      });
    }
    case "summary": {
      const r = await a.summary(w, input.era);
      return fromIntents(ctx, { ...base, ...(input.era ? { era: input.era } : {}) }, r, (d) => ({
        table: makeTable(
          [col("metric", "category"), col("value", "number", null)],
          Object.entries(d as Record<string, unknown>).map(([metric, value]) => ({ metric, value })),
        ),
        chart: { kind: "table", y: [] },
      }));
    }
    case "coverage": {
      const c = await a.coverage(w, input.era);
      const r = await a.summary(w, input.era);
      return fromIntents(
        ctx,
        { ...base, ...(input.era ? { era: input.era } : {}) },
        r,
        () => ({
          table: makeTable(
            [col("day", "time"), col("state", "category"), col("reason", "category")],
            [
              ...c.incompleteDays.map((x) => ({ ...x })),
              ...c.missingDays.map((day) => ({ day, state: "missing", reason: "no coverage record" })),
            ],
          ),
          chart: { kind: "table", y: [] },
          summary: {
            daysInWindow: c.daysInWindow,
            completeDays: c.completeDays,
            swapRows: c.swapRows,
            usdUnknownRows: c.usdUnknownRows,
            usdKnownShare: c.usdKnownShare === null ? null : Number(c.usdKnownShare),
          },
          caveats: [c.scopeNote, c.privateSettlementNote],
        }),
        "intents.coverage",
      );
    }
    case "settlement_duration":
    case "solver_metrics": {
      const r =
        input.analysis === "solver_metrics" ? await a.solverMetrics(w) : await a.settlementDuration(w);
      return cannot(
        ctx,
        { ...base },
        {
          metric: r.metric,
          missing: r.missing,
          explanation: r.explanation,
          evidence: r.evidence,
          window: w,
          provenance: r.provenance,
          coverage: intentsCoverage(r.coverage),
          caveats: [],
          ...(r.alternative
            ? {
                alternative: {
                  metric: r.alternative.metric,
                  label: r.alternative.label,
                  rows: r.alternative.data as Array<Record<string, unknown>>,
                },
              }
            : {}),
        },
      );
    }
  }
}

/** Shapes one IntentsResult: OK -> table + chart, CANNOT_COMPUTE passes through typed. */
function fromIntents<T>(
  ctx: { capability: "intents.analyze@1"; analysis: string; now: Date },
  call: Record<string, unknown>,
  r: IntentsResult<T>,
  shape: (data: T) => {
    table: ReturnType<typeof makeTable>;
    chart: {
      kind: "line" | "bar" | "stacked_bar" | "heatmap" | "table" | "cohort";
      x?: string;
      y: string[];
      series?: string;
    };
    summary?: Record<string, string | number | null>;
    caveats?: string[];
  },
  metricOverride?: string,
): AnalyticsOutcome {
  if (r.status === "CANNOT_COMPUTE")
    return cannot(ctx, call, {
      metric: r.metric,
      missing: r.missing,
      explanation: r.explanation,
      evidence: r.evidence,
      window: r.coverage ? r.coverage.window : null,
      provenance: r.provenance,
      coverage: intentsCoverage(r.coverage),
      caveats: [],
    });
  const s = shape(r.data);
  return ok(ctx, call, {
    metric: metricOverride ?? r.metric,
    definition: r.definition,
    window: r.window,
    provenance: r.provenance,
    coverage: intentsCoverage(r.coverage),
    caveats: [...r.caveats, ...(s.caveats ?? [])],
    table: s.table,
    chart: s.chart,
    ...(s.summary ? { summary: s.summary } : {}),
  });
}

/* --------------------------------------------------------------- entities */

const entCoverage = (c: Coverage | undefined, from: string, to: string) => {
  if (!c)
    return {
      state: "complete" as const,
      daysRequested: span(from, to),
      daysWithData: span(from, to),
      missingDays: [],
      incompleteDays: [],
      note: null,
    };
  const state =
    c.missingDays.length === 0
      ? ("complete" as const)
      : c.daysWithReceiverData === 0
        ? ("unavailable" as const)
        : ("partial" as const);
  return {
    state,
    daysRequested: c.daysExpected,
    daysWithData: c.daysWithReceiverData,
    missingDays: cap(c.missingDays),
    incompleteDays: [],
    note: c.missingDays.length ? "Days without receiver rows are unavailable, never zero." : null,
  };
};

let regCache: { at: number; src: EntityDataSource; reg: RegistrySnapshot } | null = null;
async function registryOf(src: EntityDataSource): Promise<RegistrySnapshot> {
  if (regCache && regCache.src === src && Date.now() - regCache.at < 60_000) return regCache.reg;
  const reg = await src.registry();
  regCache = { at: Date.now(), src, reg };
  return reg;
}

const ENT_SRC = "nearesis_live (contract_interactions via the versioned entity registry)";

async function runEntities(deps: AnalyticsDeps, input: EntitiesAnalyzeInput): Promise<AnalyticsOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const capability = "entities.analyze@1" as const;
  const ctx = { capability, analysis: input.analysis, now };
  const src = deps.entities;
  const reg = await registryOf(src);
  const prov = (tables: string[], method: string, asOf: string | null) => ({
    source: ENT_SRC,
    tables: tables.map((t) => `nearesis_live.${t}`),
    asOf,
    metricVersion: `${ENTITIES_VERSION}:${reg.registryVersion}`.slice(0, 40),
    method,
  });
  if (reg.registryVersion === "none")
    return cannot(
      ctx,
      { ...input },
      {
        metric: `entities.${input.analysis}`,
        missing: ["entity registry"],
        explanation: "No entity registry is loaded.",
        evidence: [],
        window: null,
        provenance: prov(["entities"], "registry lookup", null),
        coverage: {
          state: "unavailable",
          daysRequested: null,
          daysWithData: null,
          missingDays: [],
          incompleteDays: [],
          note: null,
        },
        caveats: [],
      },
    );
  const latest = await src.latestDate();
  const noData = () =>
    cannot(
      ctx,
      { ...input },
      {
        metric: `entities.${input.analysis}`,
        missing: ["contract_interactions rows"],
        explanation: "No contract interaction data is loaded.",
        evidence: [],
        window: null,
        provenance: prov(["contract_interactions"], "latest date lookup", null),
        coverage: {
          state: "unavailable",
          daysRequested: null,
          daysWithData: null,
          missingDays: [],
          incompleteDays: [],
          note: null,
        },
        caveats: [],
      },
    );

  switch (input.analysis) {
    case "search": {
      const needle = input.q?.toLowerCase();
      const acc = new Map<string, number>();
      for (const m of reg.mappings) acc.set(m.entityId, (acc.get(m.entityId) ?? 0) + 1);
      const rows = reg.entities
        .filter((e) => (input.type ? e.entityType === input.type : true))
        .filter(
          (e) =>
            !needle ||
            e.entityId.includes(needle) ||
            e.name.toLowerCase().includes(needle) ||
            e.description.toLowerCase().includes(needle),
        )
        .slice(0, input.limit ?? 50)
        .map((e) => ({
          entityId: e.entityId,
          name: e.name,
          entityType: e.entityType,
          categoryId: e.categoryId,
          mappingCount: acc.get(e.entityId) ?? 0,
        }));
      return ok(
        ctx,
        { analysis: "search", q: input.q ?? null, type: input.type ?? null, limit: input.limit ?? 50 },
        {
          metric: "entities.search",
          definition: "Registry entities matching the filter (reference data, not activity).",
          window: null,
          provenance: prov(["entities", "entity_mappings"], "registry read", latest),
          coverage: {
            state: "complete",
            daysRequested: null,
            daysWithData: null,
            missingDays: [],
            incompleteDays: [],
            note: null,
          },
          caveats: [],
          table: makeTable(
            [
              col("entityId", "category"),
              col("name", "category"),
              col("entityType", "category"),
              col("categoryId", "category"),
              col("mappingCount", "number", "mappings"),
            ],
            rows,
          ),
          chart: { kind: "table", y: [] },
        },
      );
    }
    case "changes": {
      if (!latest) return noData();
      const days = input.days ?? 90;
      const to = input.to ?? latest;
      const limit = input.limit ?? 15;
      const activity = await src.activity(addDaysE(to, -(2 * days - 1)), to);
      const rep = entityChanges(reg, activity, to, days);
      const types = new Map(reg.entities.map((e) => [e.entityId, e.entityType]));
      const ents = (
        input.type ? rep.entities.filter((e) => types.get(e.entityId) === input.type) : rep.entities
      ).slice(0, limit);
      const sg = deps.accounts;
      const withSigners = sg
        ? await Promise.all(
            ents
              .slice(0, 25)
              .map(async (e) => [e.entityId, await entitySignerChange(sg, e.entityId, to, days)] as const),
          )
        : [];
      const sgMap = new Map(withSigners);
      const rows = ents.map((e) => ({
        entityId: e.entityId,
        name: e.name,
        entityType: e.entityType,
        currentInteractions: e.current.interactions,
        priorInteractions: e.prior.interactions,
        change: e.change,
        changePct: e.changePct,
        shareOfGrowth: e.shareOfGrowth,
        avgDailySignersCurrent: sgMap.get(e.entityId)?.current ?? null,
        avgDailySignersPrevious: sgMap.get(e.entityId)?.previous ?? null,
        signersChangePct: sgMap.get(e.entityId)?.changePct ?? null,
      }));
      return ok(
        ctx,
        { analysis: "changes", days, to, limit, ...(input.type ? { type: input.type } : {}) },
        {
          metric: "entities.interaction_change",
          definition:
            "Function-call receipts received per entity: the last `days` days versus the preceding window of equal length. Interactions are not unique users; signer columns are exact distinct signer accounts per day averaged over the period (accounts, not people).",
          window: { from: addDaysE(to, -(2 * days - 1)), to },
          provenance: prov(
            ["contract_interactions", "entity_mappings", ...(sg ? ["account_daily_entity_signers"] : [])],
            rep.attribution,
            latest,
          ),
          coverage: entCoverage(rep.currentCoverage, rep.current.from, to),
          caveats: [
            ...rep.notes,
            ...(sg
              ? []
              : ["Unique signers per entity are CANNOT_COMPUTE here: the per-signer scan is not available."]),
            ...(ents.length > 25 && sg
              ? ["Signer columns are computed for the first 25 entities only."]
              : []),
          ],
          table: makeTable(
            [
              col("entityId", "category"),
              col("name", "category"),
              col("entityType", "category"),
              col("currentInteractions", "number", "interactions"),
              col("priorInteractions", "number", "interactions"),
              col("change", "number", "interactions"),
              col("changePct", "number", "ratio"),
              col("shareOfGrowth", "number", "ratio"),
              col("avgDailySignersCurrent", "number", "accounts"),
              col("avgDailySignersPrevious", "number", "accounts"),
              col("signersChangePct", "number", "ratio"),
            ],
            rows,
          ),
          chart: { kind: "bar", x: "name", y: ["change"] },
          summary: {
            currentTotal: rep.totals.current,
            priorTotal: rep.totals.prior,
            change: rep.totals.change,
            changePct: rep.totals.changePct,
            classifiedChange: rep.totals.classifiedChange,
            unclassifiedChange: rep.totals.unclassifiedChange,
            classifiedShareCurrent: rep.currentCoverage.classifiedShare,
          },
        },
      );
    }
    case "metrics": {
      if (!reg.entities.some((e) => e.entityId === input.entityId))
        throw new InputError("ENTITY_NOT_FOUND", `No entity ${input.entityId} in the registry.`);
      checkRange(input.from, input.to);
      const activity = await src.activity(input.from, input.to);
      const r = entityDaily(reg, activity, input.entityId, input.from, input.to);
      return ok(
        ctx,
        { analysis: "metrics", entityId: input.entityId, from: input.from, to: input.to },
        {
          metric: "entities.daily_interactions",
          definition: `Daily function-call receipts attributed to ${input.entityId} (verified + inferred mappings only), with the day total for context.`,
          window: { from: input.from, to: input.to },
          provenance: prov(
            ["contract_interactions", "entity_mappings"],
            "registry attribution (exact beats suffix, effective-dated)",
            latest,
          ),
          coverage: entCoverage(r.coverage, input.from, input.to),
          caveats: [
            "Interactions are not unique users. Unverified mappings are never counted in a named entity.",
          ],
          table: makeTable(
            [
              col("date", "time"),
              col("interactions", "number", "interactions"),
              col("verifiedInteractions", "number", "interactions"),
              col("inferredInteractions", "number", "interactions"),
              col("totalInteractions", "number", "interactions"),
              col("shareOfTotal", "number", "ratio"),
            ],
            r.points,
          ),
          chart: { kind: "line", x: "date", y: ["interactions"] },
        },
      );
    }
    case "coverage": {
      if (!latest) return noData();
      const to = input.to ?? latest;
      const from = input.from ?? addDaysE(to, -((input.days ?? 90) - 1));
      checkRange(from, to);
      const activity = await src.activity(from, to);
      const r = windowCoverage(reg, activity, from, to);
      const c = r.coverage;
      return ok(
        ctx,
        { analysis: "coverage", from, to },
        {
          metric: "entities.classification_coverage",
          definition:
            "Share of contract interactions attributed to a named, verified or inferred registry entity versus unclassified, unverified or below the per-day listing threshold.",
          window: { from, to },
          provenance: prov(
            ["contract_interactions", "entity_mappings"],
            "registry attribution over the window",
            latest,
          ),
          coverage: entCoverage(c, from, to),
          caveats: [
            "Receivers below 100 interactions per day exist only as an aggregate and are always unclassified.",
          ],
          table: makeTable(
            [
              col("receiver", "category"),
              col("state", "category"),
              col("interactions", "number", "interactions"),
            ],
            [
              ...r.topUnclassifiedReceivers.map((x) => ({ ...x, state: "unclassified" })),
              ...r.topUnverifiedReceivers.map((x) => ({ ...x, state: "unverified" })),
            ],
          ),
          chart: { kind: "bar", x: "receiver", y: ["interactions"] },
          summary: {
            totalInteractions: c.totalInteractions,
            classifiedShare: c.classifiedShare,
            verifiedShare: c.verifiedShare,
            inferredShare: c.inferredShare,
            unverifiedShare: c.unverifiedShare,
            unclassifiedShare: c.unclassifiedShare,
            belowThresholdShare: c.belowThresholdShare,
          },
        },
      );
    }
    case "unique_signers": {
      if (!reg.entities.some((e) => e.entityId === input.entityId))
        throw new InputError("ENTITY_NOT_FOUND", `No entity ${input.entityId} in the registry.`);
      const w = deps.accounts ? await deps.accounts.window() : null;
      const to = input.to ?? w?.to ?? latest;
      if (!to) return noData();
      const from = input.from ?? addDaysE(to, -((input.days ?? 90) - 1));
      checkRange(from, to);
      const call = { analysis: "unique_signers", entityId: input.entityId, from, to };
      const r = deps.accounts
        ? await entityUniqueSigners(deps.accounts, input.entityId, from, to)
        : ({
            state: "CANNOT_COMPUTE",
            entityId: input.entityId,
            reasonCode: "PER_SIGNER_SOURCE_MISSING",
            message: "The per-signer scan is not available.",
            loadedWindow: null,
          } as const);
      if (r.state === "CANNOT_COMPUTE")
        return cannot(ctx, call, {
          metric: "entities.unique_signers",
          missing: [r.reasonCode],
          explanation: r.message,
          evidence: r.loadedWindow ? [`loaded scan window ${r.loadedWindow.from}..${r.loadedWindow.to}`] : [],
          window: { from, to },
          provenance: prov(["account_daily_entity_signers"], "per-signer scan lookup", null),
          coverage: {
            state: "unavailable",
            daysRequested: span(from, to),
            daysWithData: 0,
            missingDays: [],
            incompleteDays: [],
            note: null,
          },
          caveats: [],
        });
      const cov = r.coverage;
      return ok(ctx, call, {
        metric: "entities.unique_signers",
        definition:
          "Exact distinct signer accounts per day whose transactions hit a receiver attributed to the entity. Accounts, not people; daily counts are not additive across days.",
        window: { from: r.from, to: r.to },
        provenance: prov(
          ["account_daily_entity_signers", "entity_mappings"],
          "exact per-day distinct signers from the loaded per-signer scan",
          w?.to ?? null,
        ),
        coverage: {
          state:
            cov.missingDays.length === 0 ? "complete" : cov.daysWithData === 0 ? "unavailable" : "partial",
          daysRequested: cov.requestedDays,
          daysWithData: cov.daysWithData,
          missingDays: cap(cov.missingDays),
          incompleteDays: [],
          note: cov.missingDays.length ? "Days outside the scan are gaps, never zero." : null,
        },
        caveats: [
          ...r.caveats,
          r.summary.windowDistinctSigners.message,
          ...(r.organicNote ? [r.organicNote] : []),
        ],
        table: makeTable(
          [
            col("date", "time"),
            col("signers", "number", "accounts"),
            col("transactions", "number", "transactions"),
            col("organicSigners", "number", "accounts"),
            col("organicTransactions", "number", "transactions"),
          ],
          r.daily,
        ),
        chart: { kind: "line", x: "date", y: ["signers", "organicSigners"] },
        summary: {
          averageDailySigners: r.summary.averageDailySigners,
          peakDailySigners: r.summary.peakDailySigners,
          signerDays: r.summary.signerDays,
          windowDistinctLowerBound: r.summary.windowDistinctSigners.lowerBound,
          windowDistinctUpperBound: r.summary.windowDistinctSigners.upperBound,
        },
      });
    }
  }
}

/* --------------------------------------------------------------- accounts */

const ACC_SRC = "nearesis_live (one scan of NEAR transactions: signer x receiver x day)";

async function runAccounts(deps: AnalyticsDeps, input: AccountsAnalyzeInput): Promise<AnalyticsOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const capability = "accounts.analyze@1" as const;
  const ctx = { capability, analysis: input.analysis, now };
  const src = deps.accounts;
  const w = src ? await src.window() : null;
  const prov = (w0: { to: string } | null, method: string) => ({
    source: ACC_SRC,
    tables: ["nearesis_live.account_daily_new_returning"],
    asOf: w0?.to ?? null,
    metricVersion: ACCOUNTS_VERSION,
    method,
  });
  if (!src || !w)
    return cannot(
      ctx,
      { ...input },
      {
        metric: `accounts.${input.analysis}`,
        missing: ["per-signer daily scan (account_daily_* tables)"],
        explanation:
          "The per-signer scan is not loaded, so account activity cannot be computed. It is never reported as zero.",
        evidence: ["ACCOUNT_DATA_NOT_LOADED"],
        window: null,
        provenance: prov(null, "scan window lookup"),
        coverage: {
          state: "unavailable",
          daysRequested: null,
          daysWithData: null,
          missingDays: [],
          incompleteDays: [],
          note: null,
        },
        caveats: [],
      },
    );
  const rangeOf = (i: { from?: string | undefined; to?: string | undefined; days?: number | undefined }) => {
    const to = i.to ?? w.to;
    const from = i.from ?? addDaysIso(to, -((i.days ?? 30) - 1));
    checkRange(from, to);
    return { from, to };
  };
  const meta = {
    caveats: [
      ...ACCOUNT_CAVEATS,
      `New means first organic transaction seen since the scan window start (${w.windowStart}), not lifetime.`,
    ],
  };
  const covOf = (days: string[], from: string, to: string) => {
    const c = coverageOf(days, from, to);
    return {
      state:
        c.missingDays.length === 0
          ? ("complete" as const)
          : c.daysWithData === 0
            ? ("unavailable" as const)
            : ("partial" as const),
      daysRequested: c.requestedDays,
      daysWithData: c.daysWithData,
      missingDays: cap(c.missingDays),
      incompleteDays: [],
      note: c.missingDays.length ? "Days outside the loaded scan are gaps, never zero." : null,
    };
  };
  switch (input.analysis) {
    case "coverage":
      return ok(
        ctx,
        { analysis: "coverage" },
        {
          metric: "accounts.scan_coverage",
          definition: "The window of the loaded per-signer scan and its head threshold.",
          window: { from: w.from, to: w.to },
          provenance: prov(w, "source_coverage lookup"),
          coverage: {
            state: "complete",
            daysRequested: w.days.length,
            daysWithData: w.days.length,
            missingDays: [],
            incompleteDays: [],
            note: null,
          },
          ...meta,
          table: makeTable(
            [col("metric", "category"), col("value", "number", null)],
            [
              { metric: "coveredDays", value: w.days.length },
              { metric: "headThreshold", value: w.headThreshold },
            ],
          ),
          chart: { kind: "table", y: [] },
          summary: { windowStart: w.windowStart, from: w.from, to: w.to, headThreshold: w.headThreshold },
        },
      );
    case "daily": {
      const { from, to } = rangeOf(input);
      const rows = await src.days(from, to);
      return ok(
        ctx,
        { analysis: "daily", from, to },
        {
          metric: "accounts.daily_active",
          definition:
            "Daily active organic signer accounts with new versus returning accounts. Organic excludes NEAR Intents verifier and bridge receivers.",
          window: { from, to },
          provenance: prov(w, "exact per-day distinct signer counts from one scan"),
          coverage: covOf(
            rows.map((r) => r.date),
            from,
            to,
          ),
          ...meta,
          table: makeTable(
            [
              col("date", "time"),
              col("activeAccounts", "number", "accounts"),
              col("newAccounts", "number", "accounts"),
              col("returningAccounts", "number", "accounts"),
              col("newShare", "number", "ratio"),
              col("organicTransactions", "number", "transactions"),
              col("activeAccountsAllTraffic", "number", "accounts"),
            ],
            dailyActivity(rows, w.windowStart),
          ),
          chart: { kind: "line", x: "date", y: ["activeAccounts", "newAccounts", "returningAccounts"] },
          summary: { windowStart: w.windowStart },
        },
      );
    }
    case "growth": {
      const days = input.days ?? 30;
      const to = input.to ?? w.to;
      const rows = await src.days(addDaysIso(to, -(2 * days - 1)), to);
      const g = growthContribution(rows, w.windowStart, to, days);
      const series = [
        ["activeAccounts", g.averageDailyActiveAccounts],
        ["newAccounts", g.averageDailyNewAccounts],
        ["returningAccounts", g.averageDailyReturningAccounts],
      ] as const;
      return ok(
        ctx,
        { analysis: "growth", days, to },
        {
          metric: "accounts.growth_contribution",
          definition: g.note,
          window: { from: g.previous.from, to },
          provenance: prov(w, "difference of period averages of exact daily counts"),
          coverage: {
            state: g.complete ? "complete" : "partial",
            daysRequested: 2 * days,
            daysWithData: g.current.daysWithData + g.previous.daysWithData,
            missingDays: [],
            incompleteDays: [],
            note: g.complete ? null : "Some days of the two periods are missing or are the scan's first day.",
          },
          ...meta,
          table: makeTable(
            [
              col("series", "category"),
              col("current", "number", "accounts"),
              col("previous", "number", "accounts"),
            ],
            series.map(([s, v]) => ({ series: s, current: v.current, previous: v.previous })),
          ),
          chart: { kind: "bar", x: "series", y: ["current", "previous"] },
          summary: {
            change: g.change,
            newAccountContribution: g.newAccountContribution,
            returningAccountContribution: g.returningAccountContribution,
          },
        },
      );
    }
    case "concentration": {
      const { from, to } = rangeOf(input);
      const rows = await src.days(from, to);
      const c = accountConcentration(rows);
      return ok(
        ctx,
        { analysis: "concentration", from, to },
        {
          metric: "accounts.concentration",
          definition:
            "Share of organic transactions made by the top 1%, top 5%, top 10 accounts and the head/tail per day; shares are exact.",
          window: { from, to },
          provenance: prov(w, "exact per-day shares from one scan"),
          coverage: covOf(
            rows.map((r) => r.date),
            from,
            to,
          ),
          ...meta,
          table: makeTable(
            [
              col("date", "time"),
              col("activeAccounts", "number", "accounts"),
              col("top1PctShare", "number", "ratio"),
              col("top5PctShare", "number", "ratio"),
              col("top10AccountsShare", "number", "ratio"),
              col("headShare", "number", "ratio"),
              col("tailShare", "number", "ratio"),
            ],
            c.daily,
          ),
          chart: { kind: "line", x: "date", y: ["top1PctShare", "top5PctShare", "headShare"] },
          summary: {
            rangeTop1PctShare: c.range.top1PctShare,
            rangeTop5PctShare: c.range.top5PctShare,
            rangeTop10AccountsShare: c.range.top10AccountsShare,
            rangeHeadShare: c.range.headShare,
          },
        },
      );
    }
    case "retention": {
      const r = cohortRetention(await src.retention(), w.windowStart, w.to);
      const rows = r.cohorts.flatMap((c) =>
        c.weeks.map((x) => ({
          cohortWeek: c.cohortWeek,
          weekOffset: x.weekOffset,
          accounts: x.accounts,
          rate: x.rate,
          cohortSize: c.cohortSize,
        })),
      );
      return ok(
        ctx,
        { analysis: "retention" },
        {
          metric: "accounts.weekly_retention",
          definition:
            "Weekly retention by first-seen cohort week: cohort accounts active again k weeks later divided by cohort size.",
          window: { from: w.from, to: w.to },
          provenance: prov(w, "cohort cells from one scan"),
          coverage: {
            state: "complete",
            daysRequested: w.days.length,
            daysWithData: w.days.length,
            missingDays: [],
            incompleteDays: [],
            note: null,
          },
          caveats: [...meta.caveats, ...r.notes],
          table: makeTable(
            [
              col("cohortWeek", "time"),
              col("weekOffset", "number", "weeks"),
              col("accounts", "number", "accounts"),
              col("rate", "number", "ratio"),
              col("cohortSize", "number", "accounts"),
            ],
            rows,
          ),
          chart: { kind: "cohort", x: "weekOffset", y: ["rate"], series: "cohortWeek" },
        },
      );
    }
  }
}

/** Typed refusal for a run that is not on the LIVE source: the analytics read the live warehouse, never a synthetic fixture. */
export function notLiveSource(
  capability: AnalyticsCapabilityId,
  rawInput: unknown,
  now = new Date(),
): AnalyticsOutcome {
  const analysis = String((rawInput as { analysis?: unknown } | null)?.analysis ?? "unknown").slice(0, 40);
  return cannot(
    { capability, analysis, now },
    { analysis },
    {
      metric: `${capability.split(".")[0]}.${analysis}`,
      missing: ["live data source for this run"],
      explanation:
        'Analytics capabilities read the live warehouse. This run uses the fixture (synthetic) source, so no live number is returned. Submit the question with source "live".',
      evidence: ["run source is not live"],
      window: null,
      provenance: { source: "none", tables: [], asOf: null, metricVersion: "none", method: "source gate" },
      coverage: {
        state: "unavailable",
        daysRequested: null,
        daysWithData: null,
        missingDays: [],
        incompleteDays: [],
        note: null,
      },
      caveats: [],
    },
  );
}
