import { createHash } from "node:crypto";
import type pg from "pg";
import {
  ANALYTICS_CERTIFICATION,
  AnalyticsCall,
  type AnalyticsOutcome,
  type AnalyticsPanelData,
} from "@nearesis/contracts";
import { loadQuery } from "../queries.ts";
import { runAnalytics, type AnalyticsDeps } from "./runner.ts";

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

/** Panel data (chart, shape, provenance) for one analytics outcome; the shape the semantic panel route returns, with ANALYTICS labels. */
export function panelDataOf(o: AnalyticsOutcome): AnalyticsPanelData {
  const cols = o.outcome === "OK" ? o.table.columns : [];
  const rows = o.outcome === "OK" ? o.table.rows : [];
  return {
    chart: {
      queryHash: o.callHash,
      dataRevision: 1,
      columns: cols.map((c) => ({ name: c.name, unit: c.unit })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness:
        o.outcome === "CANNOT_COMPUTE" || o.coverage.state === "unavailable"
          ? "unavailable"
          : o.coverage.state === "partial"
            ? "partial"
            : "fresh",
      sourceWatermark: o.provenance.asOf,
    },
    shape: {
      queryHash: o.callHash,
      fields: cols.map((c) => ({
        name: c.name,
        unit: c.unit,
        role:
          c.type === "time"
            ? ("time" as const)
            : c.type === "number"
              ? ("measure" as const)
              : ("dimension" as const),
      })),
    },
    provenance: {
      queryHash: o.callHash,
      sourceLabel: "ANALYTICS",
      certification: ANALYTICS_CERTIFICATION,
      capability: o.capability,
      analysis: o.analysis,
      call: o.call,
      resultHash: createHash("sha256")
        .update(canon({ columns: cols, rows }))
        .digest("hex"),
      sources: o.provenance.tables,
      metricVersion: o.provenance.metricVersion,
      definition: o.definition,
      method: o.provenance.method,
      asOf: o.provenance.asOf,
      computedAt: o.provenance.computedAt,
      coverage: o.coverage,
      caveats: o.caveats,
    },
    cannotCompute: o.outcome === "CANNOT_COMPUTE" ? { missing: o.missing, explanation: o.explanation } : null,
    truncated: o.outcome === "OK" ? o.table.truncated : false,
  };
}

export type StoredAnalyticsPanel =
  | { status: 200; body: AnalyticsPanelData }
  | { status: 404 | 422 | 503; body: { errorCode: string; reasonCode: string; message: string } };

/**
 * Re-executes the analytics call a panel cites by hash. 404 QUERY_UNKNOWN when the hash is not an analytics call (a semantic
 * query panel is served by the semantic panel route instead).
 */
export async function panelDataForHash(
  pool: pg.Pool,
  deps: AnalyticsDeps,
  hash: string,
): Promise<StoredAnalyticsPanel> {
  const saved = hash.match(/^[0-9a-f]{64}$/) ? await loadQuery(pool, hash) : null;
  const ast = saved?.ast as { kind?: string } | undefined;
  if (!saved || ast?.kind !== "analytics_call")
    return {
      status: 404,
      body: {
        errorCode: "NOT_FOUND",
        reasonCode: "QUERY_UNKNOWN",
        message: "No analytics call is stored under this hash.",
      },
    };
  const call = AnalyticsCall.safeParse({
    capability: (ast as Record<string, unknown>).capability,
    input: (ast as Record<string, unknown>).input,
  });
  if (!call.success)
    return {
      status: 422,
      body: {
        errorCode: "DOMAIN_INVARIANT",
        reasonCode: "STORED_CALL_INVALID",
        message: "The stored analytics call is not valid.",
      },
    };
  const r = await runAnalytics(deps, call.data.capability, call.data.input);
  if (!r.ok)
    return {
      status: r.status === 400 ? 422 : r.status === 404 ? 404 : 503,
      body: {
        errorCode: r.status === 503 ? "UPSTREAM_DEGRADED" : "VALIDATION_FAILED",
        reasonCode: r.code,
        message: r.message,
      },
    };
  return { status: 200, body: panelDataOf(r.outcome) };
}
