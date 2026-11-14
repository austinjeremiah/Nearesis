import {
  ANALYTICS_CERTIFICATION,
  ANALYTICS_LABEL,
  ANALYTICS_LIMITS,
  type AnalyticsCapabilityId,
  type AnalyticsOutcome,
  type AnalyticsTable,
} from "@nearesis/contracts";
import { createHash } from "node:crypto";

export const ENTITIES_VERSION = "entities-1.0.0";
export const ACCOUNTS_VERSION = "accounts-1.0.0";

export type Col = [name: string, type: "time" | "category" | "number", unit: string | null];
export const col = (name: string, type: Col[1], unit: string | null = null): Col => [name, type, unit];

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
export const callHashOf = (capability: AnalyticsCapabilityId, input: Record<string, unknown>): string =>
  createHash("sha256").update(canon({ capability, input })).digest("hex");

/** Typed table: exact decimal strings become numbers on `number` columns (chart-ready; the source keeps the exact value), nothing becomes 0. */
export function makeTable(cols: Col[], records: ReadonlyArray<object>): AnalyticsTable {
  const rows = records.slice(0, ANALYTICS_LIMITS.maxRows).map((r) =>
    cols.map(([name, type]) => {
      const v = (r as Record<string, unknown>)[name];
      if (v === null || v === undefined) return null;
      if (type === "number") {
        const x = typeof v === "number" ? v : Number(v);
        return Number.isFinite(x) ? x : null;
      }
      return String(v);
    }),
  );
  return {
    columns: cols.map(([name, type, unit]) => ({ name, type, unit })),
    rows,
    totalRows: records.length,
    truncated: records.length > ANALYTICS_LIMITS.maxRows,
  };
}

interface Ctx {
  capability: AnalyticsCapabilityId;
  analysis: string;
  now: Date;
}
type Common = Pick<
  Extract<AnalyticsOutcome, { outcome: "OK" }>,
  "metric" | "definition" | "window" | "coverage" | "caveats"
> & {
  provenance: {
    source: string;
    tables: string[];
    asOf: string | null;
    metricVersion: string;
    method: string;
  };
};

function head(
  ctx: Ctx,
  call: Record<string, unknown>,
  c: Omit<Common, "definition"> & { definition?: string },
) {
  const input = { ...call };
  return {
    capability: ctx.capability,
    analysis: ctx.analysis,
    label: ANALYTICS_LABEL,
    certification: ANALYTICS_CERTIFICATION,
    callHash: callHashOf(ctx.capability, input),
    call: { capability: ctx.capability, input },
    metric: c.metric,
    window: c.window,
    provenance: { ...c.provenance, computedAt: ctx.now.toISOString() },
    coverage: c.coverage,
    caveats: c.caveats.slice(0, 20),
  };
}

export function ok(
  ctx: Ctx,
  call: Record<string, unknown>,
  r: Common & {
    table: AnalyticsTable;
    chart: Extract<AnalyticsOutcome, { outcome: "OK" }>["chart"];
    summary?: Record<string, string | number | null>;
  },
): AnalyticsOutcome {
  return {
    outcome: "OK",
    ...head(ctx, call, r),
    definition: r.definition.slice(0, 1200),
    table: r.table,
    chart: r.chart,
    ...(r.summary ? { summary: r.summary } : {}),
  };
}

export function cannot(
  ctx: Ctx,
  call: Record<string, unknown>,
  r: Omit<Common, "definition"> & {
    missing: string[];
    explanation: string;
    evidence: string[];
    alternative?: { metric: string; label: string; rows: Array<Record<string, unknown>> };
  },
): AnalyticsOutcome {
  const alt = r.alternative;
  return {
    outcome: "CANNOT_COMPUTE",
    ...head(ctx, call, r),
    definition: `Requested ${r.metric}: the source cannot answer it.`,
    missing: r.missing.slice(0, 20),
    explanation: r.explanation.slice(0, 2000),
    evidence: r.evidence.slice(0, 10),
    ...(alt
      ? {
          alternative: {
            metric: alt.metric,
            label: alt.label.slice(0, 300),
            table: alt.rows.length
              ? makeTable(
                  Object.keys(alt.rows[0]!).map((k) =>
                    typeof alt.rows[0]![k] === "number" || /^\d+(\.\d+)?$/.test(String(alt.rows[0]![k]))
                      ? col(k, "number", null)
                      : col(k, "category"),
                  ),
                  alt.rows,
                )
              : null,
          },
        }
      : {}),
  };
}
