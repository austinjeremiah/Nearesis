import type { GridLayout, MetricMetadata, PanelKind, PanelSpec } from "@nearesis/contracts";
import type { Issue, Result } from "./issues.ts";
import {
  type FieldInfo,
  isQuoteMetric,
  periodUniqueIssue,
  type QueryResultShape,
  type TimeSemantics,
  validatePanelSpec,
} from "./panel.ts";

/**
 * Visualization request: the composer's library-independent chart intent (ch.26 "semantic IR → viz IR").
 * The compiler turns it into a contract PanelSpec plus a Viz IR, or refuses with a rule-specific code (C03, C17).
 */
export interface VizRequest {
  panelId: string;
  title: string;
  mark:
    | "line"
    | "area"
    | "bar"
    | "pie"
    | "scatter"
    | "candlestick"
    | "heatmap"
    | "table"
    | "note"
    | "waterfall"
    | "cohort";
  query: { hash: string; semanticVersion: string; grain: "hour" | "day" | "week" | "month" };
  result: QueryResultShape;
  x?: string;
  y?: string[];
  series?: string;
  tooltip?: string[];
  aggregation?: "none" | "sum" | "avg" | "min" | "max";
  scale?: "linear" | "log";
  /** Share charts (pie / share bars) must declare a common denominator and the category policy. */
  share?: { denominator: string | null; categoryPolicy: "disjoint" | "overlapping" };
  /** How to show y measures with different units. Undeclared mismatch is refused. */
  unitStrategy?: "single" | "dual_axis" | "dual_axis_disclosed" | "index_100";
  interpolateGaps?: boolean;
  completeness: "complete" | "partial" | "unavailable";
  layout: GridLayout;
  refresh?: "on_watermark" | "manual" | "pinned";
  snapshotPolicy?: "live" | "pinned";
  note?: string;
  stats?: { min: Record<string, number | null>; hasGaps: boolean };
}

export interface VizAxis {
  field: string;
  unit: string | null;
  side: "left" | "right";
  label: string;
}
export interface VizIR {
  mark: VizRequest["mark"] | "share_bar";
  x: { field: string; type: "utc_time" | "category" | "number"; timeSemantics: TimeSemantics | null } | null;
  axes: VizAxis[];
  scale: "linear" | "log" | "index_100";
  gapPolicy: "break";
  /** Every non-identity transform is declared here and shown in the panel chrome. */
  transforms: Array<{ kind: "index_100" | "dual_axis_disclosure" | "pie_as_share_bar"; label: string }>;
}

export interface Compiled {
  panel: PanelSpec;
  viz: VizIR;
}

const MARK_TO_KIND: Record<VizRequest["mark"], PanelKind> = {
  line: "timeSeries",
  area: "timeSeries",
  bar: "bar",
  pie: "bar",
  scatter: "scatter",
  candlestick: "candlestick",
  heatmap: "heatmap",
  table: "table",
  note: "note",
  waterfall: "waterfall",
  cohort: "cohort",
};

const GRAIN = { hour: 0, day: 1, week: 2, month: 3 } as const;
const NON_ADDITIVE = new Set(["count_distinct", "non_additive", "ratio"]);

export function compileVisualization(req: VizRequest, metrics: readonly MetricMetadata[]): Result<Compiled> {
  const issues: Issue[] = [];
  const fields = new Map<string, FieldInfo>(req.result.fields.map((f) => [f.name, f]));
  const metricByMember = new Map(metrics.map((m) => [m.cubeMember, m]));
  const y = req.y ?? [];
  const xInfo = req.x ? fields.get(req.x) : undefined;
  const yInfo = y.map((f) => fields.get(f));
  const transforms: VizIR["transforms"] = [];

  for (const [i, f] of [...(req.x ? [req.x] : []), ...y, ...(req.series ? [req.series] : [])].entries())
    if (!fields.has(f))
      issues.push({
        code: "FIELD_NOT_IN_RESULT",
        path: `request.fields[${i}]`,
        message: `"${f}" is not in the result`,
      });

  // Share charts: common denominator and disjoint categories (ch.26; ch.09 "no category pie over overlapping segments").
  const isShare = req.mark === "pie" || req.share !== undefined;
  if (isShare) {
    if (!req.share?.denominator)
      issues.push({
        code: "SHARE_DENOMINATOR_MISSING",
        path: "request.share.denominator",
        message: "share charts must declare a common denominator",
      });
    const overlapping =
      req.share?.categoryPolicy === "overlapping" ||
      yInfo.some((f) => f?.metricId && metricByMember.get(f.metricId)?.segmentOverlap === "overlapping");
    if (overlapping)
      issues.push({
        code: "SHARE_OVERLAPPING_SEGMENTS",
        path: "request.share.categoryPolicy",
        message: "segments overlap; a share/pie chart would double count. Use an overlap-aware chart",
      });
    if (req.mark === "pie")
      transforms.push({
        kind: "pie_as_share_bar",
        label: `Pie rendered as share-of-${req.share?.denominator ?? "?"} bar`,
      });
  }

  // Units (C03): one unit, an explicit index transform, or two axes that are both disclosed.
  const units = [...new Set(yInfo.map((f) => f?.unit ?? null).filter((u): u is string => u !== null))];
  let scale: VizIR["scale"] = req.scale ?? "linear";
  if (units.length > 1) {
    const strategy = req.unitStrategy ?? "single";
    if (strategy === "index_100") {
      scale = "index_100";
      transforms.push({
        kind: "index_100",
        label: "Indexed: each series = 100 at its first observation in range",
      });
    } else if (units.length === 2 && (strategy === "dual_axis" || strategy === "dual_axis_disclosed")) {
      transforms.push({
        kind: "dual_axis_disclosure",
        label: `Dual axis: left in ${units[0]}, right in ${units[1]}; independent scales, shapes are not comparable`,
      });
    } else
      issues.push({
        code: strategy === "single" ? "UNIT_MISMATCH" : "DUAL_AXIS_UNDISCLOSED",
        path: "request.y",
        message: `measures have incompatible units (${units.join(", ")}); declare unitStrategy "index_100" or a disclosed dual axis`,
      });
  }

  for (const [i, f] of yInfo.entries()) {
    const m = f?.metricId ? metricByMember.get(f.metricId) : f ? metricByMember.get(f.name) : undefined;
    if (!m) continue;
    if (isQuoteMetric(m) && xInfo?.timeSemantics !== "fetched_at")
      issues.push({
        code: "QUOTE_TIME_AXIS",
        path: "request.x",
        message: `quote series ${m.id} must use sample time fetchedAt, not ${xInfo?.timeSemantics ?? "unknown"} time`,
      });
    const coarser = GRAIN[req.query.grain] > GRAIN[m.grain];
    if (
      NON_ADDITIVE.has(m.aggregationLaw) &&
      (coarser || req.aggregation === "sum" || req.aggregation === "avg")
    )
      issues.push(periodUniqueIssue(m, `request.y[${i}]`));
  }

  if (scale === "log")
    for (const f of y) {
      const min = req.stats?.min[f];
      if (min !== undefined && min !== null && min <= 0)
        issues.push({
          code: "LOG_AXIS_NONPOSITIVE",
          path: "request.scale",
          message: `log axis rejects non-positive values (${f} min ${min})`,
        });
    }
  if (req.interpolateGaps)
    issues.push({
      code: "GAP_INTERPOLATION_REFUSED",
      path: "request.interpolateGaps",
      message: "lines are not interpolated across missing source days; gaps render as breaks",
    });

  if (issues.length) return { ok: false, issues };

  const boundFields = [
    ...new Set([
      ...(req.x ? [req.x] : []),
      ...y,
      ...(req.series ? [req.series] : []),
      ...(req.tooltip ?? []),
    ]),
  ];
  const unitMap: Record<string, string> = {};
  for (const f of boundFields) {
    const u = fields.get(f)?.unit;
    if (u) unitMap[f] = u;
  }
  const panelRaw = {
    panelId: req.panelId,
    schemaVersion: 1,
    kind: MARK_TO_KIND[req.mark],
    title: req.title,
    queryRef: {
      hash: req.query.hash,
      semanticVersion: req.query.semanticVersion,
      snapshotPolicy: req.snapshotPolicy ?? "live",
    },
    dataBinding: {
      fields: boundFields.length ? boundFields : ["note"],
      units: unitMap,
      timezone: "UTC",
      completeness: req.completeness,
    },
    encoding: {
      ...(req.x ? { x: req.x } : {}),
      ...(y.length ? { y } : {}),
      ...(req.series ? { series: req.series } : {}),
      ...(req.tooltip ? { tooltip: req.tooltip } : {}),
      scale,
      aggregation: req.aggregation ?? "none",
      interpolateGaps: false,
    },
    layout: req.layout,
    refreshPolicy: { mode: req.refresh ?? "on_watermark" },
    provenanceRequired: true,
    ...(req.note !== undefined ? { note: req.note } : {}),
  };
  const v = validatePanelSpec(panelRaw, { resolveQuery: () => req.result, metrics }, "compiled");
  if (!v.ok) return v;
  return {
    ok: true,
    value: {
      panel: v.value,
      viz: deriveVizIR(v.value, req.result, transforms, req.mark === "pie" ? "share_bar" : req.mark),
    },
  };
}

/** Viz IR for an already-validated PanelSpec (used by renderers for stored panels). */
export function deriveVizIR(
  p: PanelSpec,
  shape: QueryResultShape | undefined,
  extra: VizIR["transforms"] = [],
  mark?: VizIR["mark"],
): VizIR {
  const fields = new Map((shape?.fields ?? []).map((f) => [f.name, f]));
  const y = p.encoding.y ?? [];
  const units = [...new Set(y.map((f) => p.dataBinding.units[f] ?? null))];
  const scale = p.encoding.scale ?? "linear";
  const dual = units.length === 2 && scale !== "index_100";
  const transforms = [...extra];
  if (scale === "index_100" && !transforms.some((t) => t.kind === "index_100"))
    transforms.push({
      kind: "index_100",
      label: "Indexed: each series = 100 at its first observation in range",
    });
  if (dual && !transforms.some((t) => t.kind === "dual_axis_disclosure"))
    transforms.push({
      kind: "dual_axis_disclosure",
      label: `Dual axis: left in ${units[0]}, right in ${units[1]}; independent scales, shapes are not comparable`,
    });
  const xi = p.encoding.x ? fields.get(p.encoding.x) : undefined;
  return {
    mark: mark ?? (p.kind === "timeSeries" ? "line" : p.kind === "bar" ? "bar" : (p.kind as VizIR["mark"])),
    x: p.encoding.x
      ? {
          field: p.encoding.x,
          type:
            xi?.role === "time" || p.kind === "timeSeries" || p.kind === "candlestick"
              ? "utc_time"
              : xi?.role === "measure"
                ? "number"
                : "category",
          timeSemantics: xi?.timeSemantics ?? null,
        }
      : null,
    axes: y.map((f) => {
      const unit = scale === "index_100" ? "index_100" : (p.dataBinding.units[f] ?? null);
      return {
        field: f,
        unit,
        side: dual && p.dataBinding.units[f] === units[1] ? "right" : "left",
        label: `${f} (${unit ?? "no unit"})`,
      };
    }),
    scale,
    gapPolicy: "break",
    transforms,
  };
}
