"use client";
import type { MarkerSpec, PanelSpec } from "@nearesis/contracts";
import { deriveVizIR, type PanelRuntime, type VizIR } from "@nearesis/canvas-schema";
import { type PointerEvent, useMemo, useState } from "react";
import {
  Button,
  Chart,
  ChartSkeleton,
  CompletenessBadge,
  DataTable,
  EmptyState,
  FreshnessBadge,
  InvalidSpecState,
  Inspector,
  PanelCard,
  PanelNotice,
  PanelStateBadge,
  ProvenanceChip,
  UnitsBadge,
} from "@nearesis/ui";
import { toChartSpec, toNumber } from "../lib/chart-option.ts";
import { hooks } from "../lib/test-hooks.ts";
import type { GraphProjection, PanelData } from "../lib/types.ts";
import { EvidenceGraph } from "./EvidenceGraph.tsx";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

const CHART_KINDS = new Set([
  "timeSeries",
  "candlestick",
  "bar",
  "scatter",
  "heatmap",
  "waterfall",
  "cohort",
]);

function textAlternative(panel: PanelSpec, data: PanelData | null): string {
  if (!data) return `${panel.title}: no data loaded.`;
  const rows = data.chart.rows;
  const units = Object.entries(panel.dataBinding.units)
    .map(([f, u]) => `${f} in ${u}`)
    .join(", ");
  const parts = [`${panel.title}.`, `Units: ${units || "none"}.`, `Freshness: ${data.chart.freshness}.`];
  parts.push(
    `Completeness: ${panel.dataBinding.completeness}.`,
    `Source watermark: ${data.chart.sourceWatermark ?? "unknown"}.`,
  );
  for (const f of panel.encoding.y ?? []) {
    const i = data.chart.columns.findIndex((c) => c.name === f);
    const vals = rows
      .map((r) => toNumber(r[i] as string | number | null))
      .filter((v): v is number => v !== null);
    const nulls = rows.length - vals.length;
    if (vals.length)
      parts.push(
        `${f}: ${vals.length} values, min ${Math.min(...vals)}, max ${Math.max(...vals)}, ${nulls} missing.`,
      );
  }
  if (data.gaps.length)
    parts.push(`Gaps: ${data.gaps.map((g) => `${g.from.slice(0, 10)} (${g.reason})`).join(", ")}.`);
  return parts.join(" ");
}

/** Error panel for a stored spec that fails validation: isolated, labelled, never instantiates a component (C09b). */
export function InvalidPanel({
  index,
  raw,
  issues,
}: {
  index: number;
  raw: unknown;
  issues: Array<{ code: string; path: string; message: string }>;
}) {
  const layout = (raw as { layout?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } })?.layout;
  const n = (v: unknown, d: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100 ? v : d;
  return (
    <section
      className="nz-panel"
      data-panel-state="ERROR"
      data-state="ERROR"
      aria-label="Invalid panel"
      style={{
        gridColumn: `${n(layout?.x, 0) + 1} / span ${Math.max(1, Math.min(12, n(layout?.w, 6)))}`,
        gridRow: `${n(layout?.y, 0) + 1} / span ${Math.max(2, n(layout?.h, 4))}`,
        borderColor: "var(--bad)",
      }}
    >
      <div className="nz-panel-head">
        <h2 className="nz-panel-title">Invalid panel spec (stored panel #{index + 1})</h2>
        <PanelStateBadge state="ERROR" />
      </div>
      <div className="nz-panel-body">
        <InvalidSpecState index={index} issues={issues} />
      </div>
    </section>
  );
}

export function Panel(props: {
  panel: PanelSpec;
  runtime: PanelRuntime;
  data: PanelData | null;
  markers: MarkerSpec[];
  graph: GraphProjection | null;
  onMove: (dx: number, dy: number) => void;
  onBrush: (startMs: number, endMs: number) => void;
  onKeyboardRange: (startMs: number, endMs: number) => void;
  entering?: boolean;
  onMarkRange: () => void;
  onResize: (dw: number, dh: number) => void;
  onThreshold: (value: number) => void;
  onGraphLayout: (p: Record<string, { x: number; y: number }>) => void;
  hasSelection: boolean;
}) {
  const { panel, runtime, data } = props;
  const [inspect, setInspect] = useState(false);
  const [brushing, setBrushing] = useState(false);
  const [threshold, setThreshold] = useState("100");
  const shown = runtime.state === "READY" ? data : runtime.lastGood ? data : null;
  const viz: VizIR = useMemo(() => deriveVizIR(panel, data?.shape), [panel, data]);

  const built = useMemo(() => {
    if (!shown || !CHART_KINDS.has(panel.kind) || !shown.chart.rows.length) return null;
    return toChartSpec({ panel, viz, data: shown.chart, gaps: shown.gaps, markers: props.markers });
  }, [shown, panel, viz, props.markers]);

  if (
    CHART_KINDS.has(panel.kind) ||
    panel.kind === "table" ||
    panel.kind === "note" ||
    panel.kind === "evidenceGraph"
  ) {
    // registry instantiation log (C09c): only registered kinds ever reach this point
  }

  const xIdx = shown ? shown.chart.columns.findIndex((c) => c.name === panel.encoding.x) : -1;

  const drag = { x: 0, y: 0 };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    drag.x = e.clientX;
    drag.y = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const grid = e.currentTarget.closest(".nz-canvas") as HTMLElement | null;
    const colW = grid ? grid.clientWidth / 12 : 80;
    const dx = Math.round((e.clientX - drag.x) / colW);
    const dy = Math.round((e.clientY - drag.y) / 60);
    if (dx || dy) props.onMove(dx, dy);
  };

  const units = Object.entries(panel.dataBinding.units);
  // Threshold markers: crossing points are recomputed from the current data on every refresh (C12e).
  const crossings = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!shown) return out;
    const y = panel.encoding.y?.[0];
    const yi = shown.chart.columns.findIndex((c) => c.name === y);
    for (const m of props.markers) {
      if (m.anchor.kind !== "threshold") continue;
      const { op, value } = m.anchor;
      const pts: string[] = [];
      let prev: boolean | null = null;
      for (const r of shown.chart.rows) {
        const v = toNumber(r[yi] as string | number | null);
        if (v === null) {
          prev = null;
          continue;
        }
        const above = op === "gt" ? v > value : v < value;
        if (above && prev === false) pts.push(String(r[xIdx]));
        prev = above;
      }
      out[m.markerId] = pts;
    }
    hooks().crossings = { ...((hooks().crossings as object) ?? {}), ...out };
    return out;
  }, [shown, props.markers, panel.encoding.y, xIdx]);
  const freshness = data?.chart.freshness ?? "unavailable";
  const isEmpty =
    shown !== null &&
    shown.chart.rows.length === 0 &&
    panel.kind !== "note" &&
    panel.kind !== "evidenceGraph";

  const isChart = CHART_KINDS.has(panel.kind) && panel.kind !== "heatmap" && viz.x?.type === "utc_time";
  const fresh = freshness as "fresh" | "late" | "partial" | "stale" | "unavailable";
  return (
    <PanelCard
      panelId={panel.panelId}
      kind={panel.kind}
      title={panel.title}
      state={runtime.state}
      layout={panel.layout}
      entering={props.entering}
      patchKey={data?.chart.dataRevision}
      selected={props.hasSelection}
      textAlternative={textAlternative(panel, data)}
      gripLabel={`Move panel ${panel.title} (or focus panel and press Alt+Arrow)`}
      onGripPointerDown={onPointerDown}
      onGripPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (e.altKey && e.shiftKey && e.key.startsWith("Arrow") && e.target === e.currentTarget) {
          e.preventDefault();
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
            e.key
          ] as [number, number];
          props.onResize(d[0], d[1]);
          return;
        }
        if (e.altKey && e.key.startsWith("Arrow") && e.target === e.currentTarget) {
          e.preventDefault();
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
            e.key
          ] as [number, number];
          props.onMove(d[0], d[1]);
        }
      }}
      meta={
        <>
          <FreshnessBadge freshness={fresh} data-testid="freshness" />
          <CompletenessBadge completeness={panel.dataBinding.completeness} data-testid="completeness" />
          {data && (
            <ProvenanceChip
              sourceLabel={data.provenance.sourceLabel}
              certification={data.provenance.certification}
              data-testid="source-label"
            />
          )}
          <UnitsBadge units={units} data-testid="units" />
          <button
            type="button"
            className="nz-chip"
            onClick={() => setInspect((v) => !v)}
            aria-expanded={inspect}
            data-testid="provenance-toggle"
          >
            provenance
          </button>
        </>
      }
      toolbar={
        isChart ? (
          <>
            <Button
              size="sm"
              onClick={() => setBrushing((b) => !b)}
              aria-pressed={brushing}
              data-testid="select-mode"
            >
              {brushing ? "selecting (drag)" : "select range"}
            </Button>
            <label className="nz-field-inline">
              threshold
              <input
                className="nz-input"
                aria-label="Threshold value"
                data-testid="threshold-input"
                inputMode="decimal"
                size={5}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
            <Button
              size="sm"
              data-testid="add-threshold"
              onClick={() => {
                const v = Number(threshold);
                if (Number.isFinite(v)) props.onThreshold(v);
              }}
            >
              add threshold marker
            </Button>
            <Button
              size="sm"
              onClick={props.onMarkRange}
              disabled={!props.hasSelection}
              data-testid="mark-range"
            >
              mark selection
            </Button>
          </>
        ) : undefined
      }
      notices={
        <>
          {runtime.state === "STALE" && (
            <PanelNotice tone="warn" role="status" data-testid="stale-notice">
              Source is {freshness}: showing last good data from {data?.chart.sourceWatermark ?? "unknown"}.
            </PanelNotice>
          )}
          {runtime.state === "ERROR" && (
            <PanelNotice tone="bad" role="alert" data-testid="error-notice">
              {runtime.error?.code}: {runtime.error?.message}
              {runtime.lastGood ? " — showing last good data." : ""}
            </PanelNotice>
          )}
        </>
      }
      footer={
        <>
          <span data-testid="watermark">watermark {data?.chart.sourceWatermark ?? "unknown"}</span>
          {built && (
            <span data-testid="downsampling">
              downsampling: {built.downsampling.method} ({built.downsampling.renderedPoints}/
              {built.downsampling.originalPoints} pts)
            </span>
          )}
          {viz.transforms.map((t) => (
            <span key={t.kind} className="transform-label" data-testid="transform-label">
              {t.label}
            </span>
          ))}
          {Object.entries(crossings).map(([id, pts]) => (
            <span key={id} data-testid="threshold-crossings">
              threshold crossings: {pts.length}
            </span>
          ))}
          {data && data.gaps.length > 0 && (
            <span data-testid="gap-label">gaps shaded, not interpolated: {data.gaps.length}</span>
          )}
        </>
      }
      inspector={
        inspect && data ? (
          <Inspector
            data-testid="inspector"
            data={{
              queryHash: data.provenance.queryHash,
              semanticVersion: data.provenance.semanticVersion,
              semanticModelHash: data.provenance.semanticModelHash,
              sourceSnapshotId: data.provenance.sourceSnapshotId,
              rawManifestHash: data.provenance.rawManifestHash,
              certification: data.provenance.certification,
              resultHash: data.provenance.resultHash,
              sourceLabel: data.provenance.sourceLabel,
              ast: data.provenance.ast,
            }}
          />
        ) : undefined
      }
    >
      {isEmpty ? (
        <EmptyState title="No rows for this query window." data-testid="empty-state" art={false}>
          Nothing is plotted: an empty result is not a zero series.
          <br />
          Coverage: {panel.dataBinding.completeness}; gaps: {shown?.gaps.length ?? 0}; source watermark{" "}
          {shown?.chart.sourceWatermark ?? "unknown"}.
        </EmptyState>
      ) : panel.kind === "note" ? (
        <Instantiated kind="note">
          <SafeMarkdown source={panel.note ?? ""} />
        </Instantiated>
      ) : panel.kind === "table" && shown ? (
        <Instantiated kind="table">
          <DataTable columns={shown.chart.columns} rows={shown.chart.rows} />
        </Instantiated>
      ) : panel.kind === "evidenceGraph" && props.graph ? (
        <Instantiated kind="evidenceGraph">
          <EvidenceGraph projection={props.graph} onLayout={props.onGraphLayout} />
        </Instantiated>
      ) : built ? (
        <Instantiated kind={panel.kind}>
          <Chart
            spec={built.spec}
            testId={`chart-${panel.panelId}`}
            brushActive={brushing}
            onBrush={props.onBrush}
            onKeyboardRange={props.onKeyboardRange}
            instanceRef={(c) => {
              if (c) hooks().charts[panel.panelId] = c;
              else delete hooks().charts[panel.panelId];
            }}
            onFirstFrame={(ms) => {
              hooks().firstFrameMs[panel.panelId] = ms;
            }}
          />
        </Instantiated>
      ) : runtime.state === "ERROR" ? (
        <EmptyState title="No data available." art={false} />
      ) : (
        <ChartSkeleton />
      )}
    </PanelCard>
  );
}

/** Records every registry instantiation (C09c) and renders the registered component. */
function Instantiated({ kind, children }: { kind: string; children: React.ReactNode }) {
  useMemo(() => hooks().instantiated.push(kind), [kind]);
  return <>{children}</>;
}
