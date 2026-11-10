import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "../motion";
import type { ChartSpec } from "../types";
import { buildOption, chartTextAlternative } from "./buildOption";
import type { ChartInstance } from "./echarts-core";
import { readChartTheme } from "./theme";

export interface ChartProps {
  spec: ChartSpec;
  /** Brushing a time range reports UTC ms in data space, never pixels. */
  onBrush?: (startMs: number, endMs: number) => void;
  brushActive?: boolean;
  /** Keyboard cursor: arrows move, Shift extends, Enter commits (C08/C13). Time axes only. */
  onKeyboardRange?: (startMs: number, endMs: number) => void;
  onFirstFrame?: (ms: number) => void;
  /** Exposes the live instance for tests and benchmarks; never used by app code. */
  instanceRef?: (c: ChartInstance | null) => void;
  testId?: string;
  className?: string;
}

/**
 * Declared-spec chart. Accepts only a ChartSpec (data), renders with the canvas renderer so the DOM stays O(1) per
 * chart, and re-reads colours from CSS tokens whenever the theme changes.
 */
export function Chart({
  spec,
  onBrush,
  brushActive = false,
  onKeyboardRange,
  onFirstFrame,
  instanceRef,
  testId,
  className,
}: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartInstance | null>(null);
  const reduced = useReducedMotion();
  const [themeTick, setThemeTick] = useState(0);
  const [cursor, setCursor] = useState<{ i: number; anchor: number | null } | null>(null);
  const brushCb = useRef(onBrush);
  brushCb.current = onBrush;

  // Re-theme when data-theme flips or the OS scheme changes.
  useEffect(() => {
    const bump = () => setThemeTick((n) => n + 1);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", bump);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq?.removeEventListener("change", bump);
      mo.disconnect();
    };
  }, []);

  const built = useMemo(
    () =>
      buildOption(spec, { theme: readChartTheme(), reducedMotion: reduced, brush: spec.x.type === "time" }),
    // themeTick is intentional: tokens are read from the DOM.
    [spec, reduced, themeTick],
  );
  const optRef = useRef(built.option);
  optRef.current = built.option;
  const brushOn = useRef(brushActive);
  brushOn.current = brushActive;

  const applyBrush = () =>
    chart.current?.dispatchAction({
      type: "takeGlobalCursor",
      key: "brush",
      brushOption: brushOn.current ? { brushType: "lineX", brushMode: "single" } : { brushType: false },
    });

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    const t0 = performance.now();
    void import("./echarts-core").then(({ echarts }) => {
      if (disposed || !host.current) return;
      const c = echarts.init(host.current, null, { renderer: "canvas" });
      chart.current = c;
      instanceRef?.(c);
      let first = true;
      c.getZr().on("rendered", () => {
        if (!first) return;
        first = false;
        onFirstFrame?.(performance.now() - t0);
      });
      c.on("brushEnd", (p) => {
        const r = (p as { areas?: Array<{ coordRange?: [number, number] }> }).areas?.[0]?.coordRange;
        if (r) brushCb.current?.(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
      });
      c.setOption(optRef.current, { notMerge: true });
      applyBrush();
      ro = new ResizeObserver(() => c.resize());
      ro.observe(host.current);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      instanceRef?.(null);
      chart.current?.dispose();
      chart.current = null;
    };
    // One instance per mount; option changes are applied below.
  }, []);

  useEffect(() => {
    // Merge (not replace) so refreshes tween between old and new data; replace only if the series set changed.
    const c = chart.current;
    if (!c) return;
    const prev = (c.getOption() as { series?: unknown[] } | undefined)?.series?.length ?? 0;
    const next = (built.option.series as unknown[]).length;
    c.setOption(built.option, { notMerge: prev !== next });
    applyBrush();
  }, [built]);
  useEffect(applyBrush, [brushActive]);

  const timeIdx = spec.columns.findIndex((c) => c.name === spec.x.field);
  const timeAt = (i: number): number | null => {
    const v = spec.rows[i]?.[timeIdx];
    const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (spec.x.type !== "time" || !spec.rows.length) return;
    const last = spec.rows.length - 1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setCursor((c) => {
        const i = Math.max(0, Math.min(last, (c?.i ?? (step > 0 ? -1 : last + 1)) + step));
        return { i, anchor: e.shiftKey ? (c?.anchor ?? c?.i ?? i) : null };
      });
    } else if (e.key === "Enter" && cursor) {
      e.preventDefault();
      const a = timeAt(cursor.anchor ?? cursor.i);
      const b = timeAt(cursor.i);
      if (a !== null && b !== null) onKeyboardRange?.(Math.min(a, b), Math.max(a, b));
    } else if (e.key === "Escape") setCursor(null);
  };
  const yIdx = spec.columns.findIndex((c) => c.name === spec.y[0]?.field);
  const cursorText = (() => {
    if (!cursor) return "";
    const t = timeAt(cursor.i);
    const v = spec.rows[cursor.i]?.[yIdx];
    return `${t !== null ? new Date(t).toISOString().slice(0, 16) : "?"}: ${v === null || v === undefined ? "missing" : String(v)} ${spec.y[0]?.unit ?? ""}`;
  })();

  return (
    <div
      className={`nz-chart${className ? ` ${className}` : ""}`}
      tabIndex={0}
      role="group"
      aria-roledescription="chart"
      aria-label={`${spec.title}. Use arrow keys to move through points, Shift with arrows to extend a range, Enter to select it.`}
      onKeyDown={onKey}
      data-testid="chart-keyboard"
    >
      <div ref={host} className="nz-chart-host" data-testid={testId} aria-hidden="true" />
      <p className="nz-sr-only">{chartTextAlternative(spec)}</p>
      <div className="nz-sr-only" aria-live="polite" data-testid="cursor-live">
        {cursorText}
      </div>
    </div>
  );
}
