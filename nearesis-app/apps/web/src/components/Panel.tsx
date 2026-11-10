"use client";
import type { MarkerSpec, PanelSpec } from "@nearesis/contracts";
import { deriveVizIR, type PanelRuntime, type VizIR } from "@nearesis/canvas-schema";
import { type KeyboardEvent, type PointerEvent, useMemo, useState } from "react";
import { buildChartOption, toNumber } from "../lib/chart-option.ts";
import { hooks } from "../lib/test-hooks.ts";
import type { GraphProjection, PanelData } from "../lib/types.ts";
import { EChart } from "./EChart.tsx";
import { EvidenceGraph } from "./EvidenceGraph.tsx";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

export interface Palette {
  fg: string;
  muted: string;
  grid: string;
  series: string[];
  gap: string;
  marker: string;
}

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
      className="panel error"
      data-testid={`invalid-panel-${index}`}
      data-panel-state="ERROR"
      aria-label="Invalid panel"
      style={{
        gridColumn: `${n(layout?.x, 0) + 1} / span ${Math.max(1, Math.min(12, n(layout?.w, 6)))}`,
        gridRow: `${n(layout?.y, 0) + 1} / span ${Math.max(2, n(layout?.h, 4))}`,
      }}
    >
      <div className="panel-head">
        <h2 className="panel-title">Invalid panel spec (stored panel #{index + 1})</h2>
        <span className="badge ERROR">ERROR</span>
      </div>
      <div className="state-msg">
        <strong>This panel was not rendered.</strong> Its stored specification failed validation:
        <ul>
          {issues.slice(0, 6).map((i, k) => (
            <li key={k}>
              <code>{i.code}</code> at <code>{i.path}</code>
            </li>
          ))}
        </ul>
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
  palette: Palette | null;
  onMove: (dx: number, dy: number) => void;
  onBrush: (startMs: number, endMs: number) => void;
  onKeyboardRange: (startMs: number, endMs: number) => void;
  onMarkRange: () => void;
  onResize: (dw: number, dh: number) => void;
  onThreshold: (value: number) => void;
  onGraphLayout: (p: Record<string, { x: number; y: number }>) => void;
  hasSelection: boolean;
}) {
  const { panel, runtime, data, palette } = props;
  const [inspect, setInspect] = useState(false);
  const [brushing, setBrushing] = useState(false);
  const [threshold, setThreshold] = useState("100");
  const [cursor, setCursor] = useState<{ i: number; anchor: number | null } | null>(null);
  const shown = runtime.state === "READY" ? data : runtime.lastGood ? data : null;
  const viz: VizIR = useMemo(() => deriveVizIR(panel, data?.shape), [panel, data]);

  const built = useMemo(() => {
    if (!shown || !palette || !CHART_KINDS.has(panel.kind) || !shown.chart.rows.length) return null;
    return buildChartOption({
      panel,
      viz,
      data: shown.chart,
      gaps: shown.gaps,
      markers: props.markers,
      palette,
    });
  }, [shown, palette, panel, viz, props.markers]);

  if (
    CHART_KINDS.has(panel.kind) ||
    panel.kind === "table" ||
    panel.kind === "note" ||
    panel.kind === "evidenceGraph"
  ) {
    // registry instantiation log (C09c): only registered kinds ever reach this point
  }

  const xIdx = shown ? shown.chart.columns.findIndex((c) => c.name === panel.encoding.x) : -1;
  const timeAt = (i: number): number | null => {
    const v = shown?.chart.rows[i]?.[xIdx];
    const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(t) ? t : null;
  };

  const onChartKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!shown || viz.x?.type !== "utc_time" || !shown.chart.rows.length) return;
    const last = shown.chart.rows.length - 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setCursor((c) => {
        const i = Math.max(0, Math.min(last, (c?.i ?? (step > 0 ? -1 : last + 1)) + step));
        const anchor = e.shiftKey ? (c?.anchor ?? c?.i ?? i) : null;
        return { i, anchor };
      });
    } else if (e.key === "Enter" && cursor) {
      e.preventDefault();
      const a = timeAt(cursor.anchor ?? cursor.i);
      const b = timeAt(cursor.i);
      if (a !== null && b !== null) props.onKeyboardRange(Math.min(a, b), Math.max(a, b));
    } else if (e.key === "Escape") setCursor(null);
  };

  const cursorText = (() => {
    if (!cursor || !shown) return "";
    const t = timeAt(cursor.i);
    const y = panel.encoding.y?.[0];
    const yi = shown.chart.columns.findIndex((c) => c.name === y);
    const v = shown.chart.rows[cursor.i]?.[yi];
    const range =
      cursor.anchor !== null
        ? ` (range from ${new Date(timeAt(cursor.anchor) ?? 0).toISOString().slice(0, 10)})`
        : "";
    return `${t !== null ? new Date(t).toISOString().slice(0, 16) : "?"}: ${v === null || v === undefined ? "missing" : String(v)} ${panel.dataBinding.units[y ?? ""] ?? ""}${range}`;
  })();

  const drag = { x: 0, y: 0 };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    drag.x = e.clientX;
    drag.y = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const grid = e.currentTarget.closest(".canvas-grid") as HTMLElement | null;
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

  return (
    <section
      className={`panel${runtime.state === "ERROR" ? " error" : ""}`}
      data-testid={`panel-${panel.panelId}`}
      data-panel-kind={panel.kind}
      data-panel-state={runtime.state}
      aria-labelledby={`t-${panel.panelId}`}
      tabIndex={0}
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
      style={{
        gridColumn: `${panel.layout.x + 1} / span ${Math.min(12, panel.layout.w)}`,
        gridRow: `${panel.layout.y + 1} / span ${panel.layout.h}`,
      }}
    >
      <div className="panel-head">
        <button
          className="drag-handle"
          aria-label={`Move panel ${panel.title} (or focus panel and press Alt+Arrow)`}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          ⠿
        </button>
        <h2 className="panel-title" id={`t-${panel.panelId}`} data-testid="panel-title">
          {panel.title}
        </h2>
        <span className={`badge ${runtime.state}`} data-testid="panel-state">
          {runtime.state}
        </span>
      </div>
      <div className="panel-meta">
        <span className={`badge ${freshness}`} data-testid="freshness">
          {freshness}
        </span>
        <span className={`badge ${panel.dataBinding.completeness}`} data-testid="completeness">
          {panel.dataBinding.completeness}
        </span>
        {data && (
          <span className="badge synthetic" data-testid="source-label">
            {data.provenance.sourceLabel}
          </span>
        )}
        <span className="badge" data-testid="units">
          units: {units.length ? units.map(([f, u]) => `${f.split(".").pop()}=${u}`).join(", ") : "n/a"}
        </span>
        <button onClick={() => setInspect((v) => !v)} aria-expanded={inspect} data-testid="provenance-toggle">
          provenance
        </button>
        {CHART_KINDS.has(panel.kind) && viz.x?.type === "utc_time" && (
          <>
            <button onClick={() => setBrushing((b) => !b)} aria-pressed={brushing} data-testid="select-mode">
              {brushing ? "selecting (drag)" : "select range"}
            </button>
            <label className="badge">
              threshold
              <input
                aria-label="Threshold value"
                data-testid="threshold-input"
                inputMode="decimal"
                size={5}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
            <button
              data-testid="add-threshold"
              onClick={() => {
                const v = Number(threshold);
                if (Number.isFinite(v)) props.onThreshold(v);
              }}
            >
              add threshold marker
            </button>
          </>
        )}
        {CHART_KINDS.has(panel.kind) && viz.x?.type === "utc_time" && (
          <button onClick={props.onMarkRange} disabled={!props.hasSelection} data-testid="mark-range">
            mark selection
          </button>
        )}
      </div>
      {runtime.state === "STALE" && (
        <div className="notice" role="status" data-testid="stale-notice">
          Source is {freshness}: showing last good data from {data?.chart.sourceWatermark ?? "unknown"}.
        </div>
      )}
      {runtime.state === "ERROR" && (
        <div className="notice" role="alert" data-testid="error-notice">
          {runtime.error?.code}: {runtime.error?.message}
          {runtime.lastGood ? " — showing last good data." : ""}
        </div>
      )}
      <div className="panel-body">
        {isEmpty ? (
          <div className="state-msg" data-testid="empty-state">
            <strong>No rows for this query window.</strong> Nothing is plotted: an empty result is not a zero
            series.
            <br />
            Coverage: {panel.dataBinding.completeness}; gaps: {shown?.gaps.length ?? 0}; source watermark{" "}
            {shown?.chart.sourceWatermark ?? "unknown"}.
          </div>
        ) : panel.kind === "note" ? (
          <Instantiated kind="note">
            <SafeMarkdown source={panel.note ?? ""} />
          </Instantiated>
        ) : panel.kind === "table" && shown ? (
          <Instantiated kind="table">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {shown.chart.columns.map((c) => (
                      <th key={c.name}>
                        {c.name}
                        {c.unit ? ` (${c.unit})` : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.chart.rows.slice(0, 500).map((r, i) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j}>{v === null ? "—" : String(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Instantiated>
        ) : panel.kind === "evidenceGraph" && props.graph ? (
          <Instantiated kind="evidenceGraph">
            <EvidenceGraph projection={props.graph} onLayout={props.onGraphLayout} />
          </Instantiated>
        ) : built ? (
          <Instantiated kind={panel.kind}>
            <div
              tabIndex={0}
              role="group"
              aria-roledescription="chart"
              aria-label={`${panel.title}. Use arrow keys to move through points, Shift+arrows to extend a range, Enter to select it.`}
              onKeyDown={onChartKey}
              data-testid="chart-keyboard"
              style={{ position: "absolute", inset: 0 }}
            >
              <EChart
                panelId={panel.panelId}
                option={built.option}
                onBrush={props.onBrush}
                brushActive={brushing}
              />
            </div>
          </Instantiated>
        ) : (
          <div className="state-msg">{runtime.state === "ERROR" ? "No data available." : "Loading…"}</div>
        )}
      </div>
      <div className="sr-only" aria-live="polite" data-testid="cursor-live">
        {cursorText}
      </div>
      <div className="panel-foot">
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
      </div>
      <details className="sr-only-toggle">
        <summary className="sr-only">Text alternative</summary>
      </details>
      <p className="sr-only" data-testid="text-alternative">
        {textAlternative(panel, data)}
      </p>
      {inspect && data && (
        <pre className="inspector" data-testid="inspector">
          {JSON.stringify(
            {
              queryHash: data.provenance.queryHash,
              semanticVersion: data.provenance.semanticVersion,
              semanticModelHash: data.provenance.semanticModelHash,
              sourceSnapshotId: data.provenance.sourceSnapshotId,
              rawManifestHash: data.provenance.rawManifestHash,
              certification: data.provenance.certification,
              resultHash: data.provenance.resultHash,
              sourceLabel: data.provenance.sourceLabel,
              ast: data.provenance.ast,
            },
            null,
            2,
          )}
        </pre>
      )}
    </section>
  );
}

/** Records every registry instantiation (C09c) and renders the registered component. */
function Instantiated({ kind, children }: { kind: string; children: React.ReactNode }) {
  useMemo(() => hooks().instantiated.push(kind), [kind]);
  return <>{children}</>;
}
