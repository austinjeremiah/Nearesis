import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ORIGIN, ensureServer } from "./server";

/**
 * Chart benchmark against the frozen C18 thresholds (apps/web/test/perf/C18.reference.json):
 * DOM <= 5000 nodes per chart, heap increase <= 150 MB, first frame <= 3000 ms, no main-thread task > 250 ms.
 * Candidates: ECharts (current, with min/max downsampling and without), uPlot, TradingView lightweight-charts, Recharts.
 */
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../NEARESIS_Build_Bible/reports/TESTS/UI-DESIGN",
);
const T = { dom: 5000, heapMB: 150, firstFrameMs: 3000, taskMs: 250 };
const CASES: Array<{ lib: string; kind: "line" | "scatter"; n: number }> = [
  { lib: "echarts", kind: "line", n: 100000 },
  { lib: "echarts-raw", kind: "line", n: 100000 },
  { lib: "echarts", kind: "scatter", n: 50000 },
  { lib: "uplot", kind: "line", n: 100000 },
  { lib: "uplot", kind: "scatter", n: 50000 },
  { lib: "lwc", kind: "line", n: 100000 },
  { lib: "recharts", kind: "line", n: 100000 },
  { lib: "recharts", kind: "scatter", n: 50000 },
];
const REPS = 3;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;

export async function bench() {
  const stop = await ensureServer();
  const browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const results: Array<Record<string, unknown>> = [];
  for (const c of CASES) {
    const runs: Array<{
      ff: number;
      dom: number;
      task: number;
      heap: number;
      rendered: number;
      err?: string;
    }> = [];
    for (let r = 0; r < REPS; r++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Performance.enable");
      await page.goto(`${ORIGIN}/#/bench`);
      await page.waitForTimeout(500);
      await cdp.send("HeapProfiler.collectGarbage");
      const heap = async () =>
        ((await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize")?.value ??
          0) / 1048576;
      const before = await heap();
      await page.goto(`${ORIGIN}/#/bench?lib=${c.lib}&kind=${c.kind}&n=${c.n}`);
      await page.reload();
      try {
        await page.waitForFunction(() => window.__bench?.done === true, undefined, { timeout: 60000 });
      } catch {
        /* recorded as a failure below */
      }
      const b = await page.evaluate(() => window.__bench ?? null);
      await cdp.send("HeapProfiler.collectGarbage");
      const after = await heap();
      runs.push({
        ff: b?.firstFrameMs ?? Infinity,
        dom: b?.domNodes ?? Infinity,
        task: b?.maxTaskMs ?? Infinity,
        heap: after - before,
        rendered: b?.rendered ?? 0,
        ...(b?.error ? { err: b.error } : {}),
      });
      await ctx.close();
    }
    const err = runs.find((x) => x.err)?.err;
    const m = {
      lib: c.lib,
      kind: c.kind,
      points: c.n,
      renderedPoints: runs[0]?.rendered ?? 0,
      firstFrameMs: Math.round(median(runs.map((x) => x.ff))),
      domNodes: median(runs.map((x) => x.dom)),
      maxTaskMs: Math.round(median(runs.map((x) => x.task))),
      heapIncreaseMB: +median(runs.map((x) => x.heap)).toFixed(1),
      error: err ?? null,
    };
    const pass =
      !err &&
      m.domNodes <= T.dom &&
      m.heapIncreaseMB <= T.heapMB &&
      m.firstFrameMs <= T.firstFrameMs &&
      m.maxTaskMs <= T.taskMs;
    results.push({ ...m, verdict: err ? "N/A" : pass ? "PASS" : "FAIL" });
    console.log(JSON.stringify(results.at(-1)));
  }
  await browser.close();
  stop();
  mkdirSync(OUT, { recursive: true });
  const doc = {
    generatedAt: new Date().toISOString(),
    note: "Design-lab production build, headless Chromium, 1440x900, no throttling, median of 3, fresh context per run. Thresholds copied from apps/web/test/perf/C18.reference.json (frozen). Not a C18 acceptance run: it benchmarks chart libraries, not the canvas.",
    thresholds: T,
    results,
  };
  writeFileSync(resolve(OUT, "chart-benchmark.json"), JSON.stringify(doc, null, 2) + "\n");
  const md = [
    "| library | kind | points | rendered | first frame ms | DOM nodes | max task ms | heap MB | verdict |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results)
    md.push(
      `| ${r.lib} | ${r.kind} | ${r.points} | ${r.renderedPoints} | ${r.firstFrameMs} | ${r.domNodes} | ${r.maxTaskMs} | ${r.heapIncreaseMB} | ${r.verdict}${r.error ? ` (${String(r.error).slice(0, 60)})` : ""} |`,
    );
  writeFileSync(resolve(OUT, "chart-benchmark.md"), md.join("\n") + "\n");
  return doc;
}

if (import.meta.url === `file://${process.argv[1]}`) void bench();
