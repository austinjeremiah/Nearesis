import { Chart, type ChartSpec, minMaxBucket } from "@nearesis/ui";
import { LineSeries, createChart } from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { CartesianGrid, Line, LineChart, Scatter, ScatterChart, XAxis, YAxis } from "recharts";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { bigScatter, bigSeries } from "../fixtures/data";

declare global {
  interface Window {
    __bench?: {
      lib: string;
      kind: string;
      n: number;
      done: boolean;
      firstFrameMs: number | null;
      domNodes: number | null;
      maxTaskMs: number;
      error?: string;
      rendered?: number;
    };
  }
}

/**
 * Chart benchmark harness. URL: #/bench?lib=echarts|echarts-raw|uplot|lwc|recharts&kind=line|scatter&n=100000.
 * Writes window.__bench for the Playwright runner (e2e/bench.ts), which also samples the JS heap through CDP.
 */
export function BenchPage() {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const lib = q.get("lib") ?? "echarts";
  const kind = (q.get("kind") ?? "line") as "line" | "scatter";
  const n = Number(q.get("n") ?? 100000);
  const host = useRef<HTMLDivElement>(null);

  const state = useRef({ t0: performance.now(), maxTask: 0 });
  useEffect(() => {
    window.__bench = { lib, kind, n, done: false, firstFrameMs: null, domNodes: null, maxTaskMs: 0 };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) state.current.maxTask = Math.max(state.current.maxTask, e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* longtask unsupported */
    }
  }, [lib, kind, n]);

  const finish = (rendered: number) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const b = window.__bench!;
        b.firstFrameMs = performance.now() - state.current.t0;
        b.rendered = rendered;
        setTimeout(() => {
          // Counted after settle so lazily rendered SVG nodes (Recharts) are included.
          b.domNodes = host.current ? host.current.querySelectorAll("*").length : null;
          b.maxTaskMs = state.current.maxTask;
          b.done = true;
        }, 400);
      }),
    );
  };

  const data = useMemo(() => (kind === "line" ? bigSeries(n) : null), [kind, n]);
  const scatter = useMemo(() => (kind === "scatter" ? bigScatter(n) : null), [kind, n]);

  const echartsSpec = useMemo<ChartSpec | null>(() => {
    if (lib !== "echarts" && lib !== "echarts-raw") return null;
    if (kind === "scatter")
      return {
        kind: "scatter",
        title: "Scatter",
        columns: [
          { name: "x", unit: null },
          { name: "y", unit: null },
        ],
        rows: scatter!.map(([x, y]) => [x, y]),
        x: { field: "x", type: "value" },
        y: [{ field: "y" }],
      };
    const pts = lib === "echarts" ? minMaxBucket(data!.rows, 2000) : data!.rows;
    return {
      kind: "line",
      title: "Series",
      columns: [
        { name: "t", unit: null },
        { name: "v", unit: null },
      ],
      rows: pts.map(([t, v]) => [t, v]),
      x: { field: "t", type: "time" },
      y: [{ field: "v" }],
      downsampling: { method: lib === "echarts" ? "min_max_bucket" : "none", originalPoints: n },
    };
  }, [lib, kind, data, scatter, n]);

  useEffect(() => {
    const el = host.current;
    if (!el || lib === "echarts" || lib === "echarts-raw") return;
    try {
      if (lib === "uplot") {
        const opts: uPlot.Options = {
          width: el.clientWidth,
          height: el.clientHeight,
          scales: { x: { time: kind === "line" } },
          series:
            kind === "line"
              ? [{}, { stroke: "#2f62c9", width: 1.5 }]
              : [
                  {},
                  { stroke: "#2f62c9", paths: () => null, points: { show: true, size: 2, fill: "#2f62c9" } },
                ],
        };
        const xs = kind === "line" ? data!.rows.map((r) => r[0] / 1000) : scatter!.map((r) => r[0]);
        const ys = kind === "line" ? data!.rows.map((r) => r[1]) : scatter!.map((r) => r[1]);
        if (kind === "scatter") {
          const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
          const sx = idx.map((i) => xs[i]!);
          const sy = idx.map((i) => ys[i]!);
          new uPlot(opts, [sx, sy], el);
        } else new uPlot(opts, [xs, ys], el);
        finish(xs.length);
      } else if (lib === "lwc") {
        if (kind === "scatter") throw new Error("lightweight-charts has no scatter series");
        const c = createChart(el, { width: el.clientWidth, height: el.clientHeight });
        const s = c.addSeries(LineSeries, { color: "#2f62c9" });
        s.setData(data!.rows.map(([t, v]) => ({ time: Math.floor(t / 1000) as never, value: v })));
        c.timeScale().fitContent();
        finish(data!.rows.length);
      }
    } catch (e) {
      window.__bench!.error = String(e);
      window.__bench!.done = true;
    }
    return () => {
      el.innerHTML = "";
    };
  }, [lib, kind, data, scatter]);

  useEffect(() => {
    if (lib === "recharts") finish(kind === "line" ? n : n);
  }, [lib, kind, n]);

  return (
    <div style={{ padding: 16 }}>
      <p className="nz-sb-meta">
        {lib} · {kind} · {n.toLocaleString("en-US")} points
      </p>
      <div ref={host} data-testid="bench-host" style={{ position: "relative", width: 900, height: 420 }}>
        {echartsSpec ? (
          <Chart
            spec={echartsSpec}
            onFirstFrame={(ms) => {
              state.current.t0 = performance.now() - ms;
              finish(echartsSpec.rows.length);
            }}
          />
        ) : null}
        {lib === "recharts" && kind === "line" ? (
          <LineChart width={900} height={420} data={data!.rows.map(([t, v]) => ({ t, v }))}>
            <CartesianGrid />
            <XAxis dataKey="t" type="number" domain={["auto", "auto"]} />
            <YAxis />
            <Line dataKey="v" dot={false} isAnimationActive={false} stroke="#2f62c9" />
          </LineChart>
        ) : null}
        {lib === "recharts" && kind === "scatter" ? (
          <ScatterChart width={900} height={420}>
            <XAxis dataKey="x" type="number" />
            <YAxis dataKey="y" type="number" />
            <Scatter data={scatter!.map(([x, y]) => ({ x, y }))} isAnimationActive={false} fill="#2f62c9" />
          </ScatterChart>
        ) : null}
      </div>
    </div>
  );
}
