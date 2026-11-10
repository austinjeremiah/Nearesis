"use client";
import { useEffect, useRef } from "react";
import type { EChartsOption } from "../lib/chart-option.ts";
import { hooks } from "../lib/test-hooks.ts";

type ECharts = {
  setOption: (o: unknown, opts?: unknown) => void;
  resize: () => void;
  dispose: () => void;
  on: (ev: string, fn: (p: unknown) => void) => void;
  dispatchAction: (a: unknown) => void;
  getZr: () => { on: (ev: string, fn: () => void) => void };
};

/**
 * Mounts one ECharts instance (canvas renderer, so the DOM stays O(1) per panel: C18 DOM bound) and reports a brushed
 * x-range in data space (UTC ms), never pixels (C13).
 */
export function EChart({
  panelId,
  option,
  onBrush,
  onFirstFrame,
}: {
  panelId: string;
  option: EChartsOption;
  onBrush?: (startMs: number, endMs: number) => void;
  onFirstFrame?: (ms: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const brushRef = useRef(onBrush);
  brushRef.current = onBrush;
  const optRef = useRef(option);
  optRef.current = option;

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    const t0 = performance.now();
    void import("echarts").then((echarts) => {
      if (disposed || !host.current) return;
      const c = echarts.init(host.current, null, { renderer: "canvas" }) as unknown as ECharts;
      chart.current = c;
      hooks().charts[panelId] = c;
      let first = true;
      c.getZr().on("rendered", () => {
        if (!first) return;
        first = false;
        const ms = performance.now() - t0;
        hooks().firstFrameMs[panelId] = ms;
        onFirstFrame?.(ms);
      });
      c.on("brushEnd", (p) => {
        const areas = (p as { areas?: Array<{ coordRange?: [number, number] }> }).areas ?? [];
        const r = areas[0]?.coordRange;
        if (r && brushRef.current) brushRef.current(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
      });
      c.setOption(optRef.current, { notMerge: true, lazyUpdate: false });
      ro = new ResizeObserver(() => c.resize());
      ro.observe(host.current);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      delete hooks().charts[panelId];
    };
    // Instance lifetime is per panel; option updates are applied by the effect below.
  }, [panelId]);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: false });
  }, [option]);

  return <div ref={host} className="chart-host" data-testid={`chart-${panelId}`} aria-hidden="true" />;
}
