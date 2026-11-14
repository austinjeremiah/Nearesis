import {
  ANALYTICS_CERTIFICATION,
  ANALYTICS_CONTRACT_VERSION,
  ANALYTICS_LABEL,
  type AnalyticsOkResult,
  type GridLayout,
  type PanelKind,
} from "@nearesis/contracts";
import { deriveVizIR, type Compiled } from "./compiler.ts";
import type { Result } from "./issues.ts";
import { validatePanelSpec, type QueryResultShape } from "./panel.ts";

const KIND_FOR: Record<AnalyticsOkResult["chart"]["kind"], PanelKind> = {
  line: "timeSeries",
  bar: "bar",
  stacked_bar: "bar",
  heatmap: "heatmap",
  table: "table",
  cohort: "cohort",
};

/** Result shape a panel binds to: the analytics table's typed columns. */
export function analyticsShape(r: AnalyticsOkResult): QueryResultShape {
  return {
    queryHash: r.callHash,
    fields: r.table.columns.map((c) => ({
      name: c.name,
      unit: c.unit,
      role: c.type === "time" ? "time" : c.type === "number" ? "measure" : "dimension",
    })),
  };
}

/**
 * Turns an analytics capability result into a typed panel. The panel references the executed call by its hash
 * (`queryRef.hash`, `resultKind: "analytics_result"`) and carries an explicit ANALYTICS_RESULT binding: it is computed from
 * certified source tables and is never presented as a certified semantic metric. Encoding comes from the result's chart hint,
 * not from the model. Refuses with a rule-specific code when the typed result cannot be drawn honestly.
 */
export function compileAnalyticsPanel(
  r: AnalyticsOkResult,
  o: { panelId: string; title: string; layout: GridLayout },
): Result<Compiled> {
  const hint = r.chart;
  let kind = KIND_FOR[hint.kind];
  const xCol = hint.x ? r.table.columns.find((c) => c.name === hint.x) : undefined;
  // a line over a non-time x is a category comparison, not a time series
  if (kind === "timeSeries" && xCol?.type !== "time") kind = "bar";
  const bound = [
    ...new Set([
      ...(hint.x ? [hint.x] : []),
      ...hint.y,
      ...(hint.series ? [hint.series] : []),
      ...r.table.columns.map((c) => c.name),
    ]),
  ].slice(0, 32);
  const units: Record<string, string> = {};
  for (const c of r.table.columns) if (c.unit && bound.includes(c.name)) units[c.name] = c.unit;
  const plotted = kind !== "table";
  const y = plotted ? hint.y.filter((f) => units[f]) : [];
  const encoding = plotted
    ? {
        ...(hint.x ? { x: hint.x } : {}),
        ...(y.length ? { y } : {}),
        ...(hint.series ? { series: hint.series } : {}),
        scale: "linear",
        aggregation: "none",
        interpolateGaps: false,
      }
    : { scale: "linear", aggregation: "none", interpolateGaps: false };
  const note = [
    `${ANALYTICS_LABEL}: computed from source tables (${r.provenance.tables.join(", ") || "none"}); not a certified semantic metric.`,
    r.coverage.state === "complete"
      ? "Coverage: complete."
      : `Coverage: ${r.coverage.state}${r.coverage.note ? ` (${r.coverage.note})` : ""}.`,
    ...(r.table.truncated ? [`Showing ${r.table.rows.length} of ${r.table.totalRows} rows.`] : []),
    ...r.caveats.slice(0, 3),
  ]
    .join(" ")
    .slice(0, 4000);
  const raw = {
    panelId: o.panelId,
    schemaVersion: 1,
    kind,
    title: o.title,
    queryRef: {
      hash: r.callHash,
      semanticVersion: ANALYTICS_CONTRACT_VERSION,
      snapshotPolicy: "live",
      resultKind: "analytics_result",
    },
    dataBinding: { fields: bound, units, timezone: "UTC", completeness: r.coverage.state },
    encoding,
    layout: o.layout,
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
    note,
    analytics: {
      capability: r.capability,
      analysis: r.analysis,
      label: ANALYTICS_LABEL,
      certification: ANALYTICS_CERTIFICATION,
      sourceTables: r.provenance.tables.slice(0, 12),
      metricVersion: r.provenance.metricVersion.slice(0, 40),
      coverageState: r.coverage.state,
    },
  };
  const shape = analyticsShape(r);
  const v = validatePanelSpec(raw, { resolveQuery: () => shape }, "compiled");
  if (!v.ok) return v;
  return {
    ok: true,
    value: {
      panel: v.value,
      viz: deriveVizIR(
        v.value,
        shape,
        [],
        hint.kind === "stacked_bar" ? "bar" : hint.kind === "line" ? "line" : undefined,
      ),
    },
  };
}
