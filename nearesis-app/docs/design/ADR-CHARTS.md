# ADR draft: chart framework for the research canvas

Status: DRAFT by agent A12 for the lead to file. Date 2026-11-10. Decision: **keep Apache ECharts 6.1.0 (canvas renderer) with a Nearesis token theme and a modular import build; do not replace it.** uPlot is recorded as an optional accelerator for a future dense time-series kind, not adopted now.

## Context

The canvas renders only declared, validated specs (C02, C10): no model-generated code, no formatter functions, no HTML from specs. Large series must stay inside the frozen C18 thresholds (`apps/web/test/perf/C18.reference.json`): at most 5,000 DOM nodes per chart, heap increase at most 150 MB, first frame at most 3,000 ms for 100k line and 50k scatter, no main-thread task over 250 ms, with the downsampling method visible. The owner also wants a modern look, so the library must theme well and handle line, area, bar, scatter, heatmap and candlestick, markers, gap shading, brush selection and keyboard access.

## Candidates

ECharts 6.1.0 (in use), uPlot 1.6.32, TradingView lightweight-charts 5.2.1, Recharts 3.10.1 (SVG baseline), visx and Nivo (SVG; judged on architecture, not benchmarked because SVG-per-point fails the DOM bound by construction, as Recharts shows), Vega-Lite (declarative, but its runtime evaluates expression strings, which conflicts with the no-formatter rule), deck.gl (GPU map layer, out of scope). Sources in `RESEARCH.md`.

## Benchmark (measured, not quoted)

Harness: design lab page `#/bench` (`apps/design-lab/src/pages/BenchPage.tsx`) driven by `apps/design-lab/e2e/bench.ts`. Production build served by `vite preview` on 127.0.0.1:3400; headless Chromium, 1440 x 900, no throttling, fresh browser context per run, median of 3. Heap is `JSHeapUsedSize` after forced GC, before page load vs after the chart settles. Fixtures: a 100,000-point line with five injected single-point spikes and a 50,000-point scatter, both deterministic (`fixtures/data.ts`). Thresholds copied from the frozen C18 file. Machine: the C18 reference machine class (Apple M2 Pro, Darwin 27, Node 24.22.2); this is a library comparison, not a C18 acceptance run.

| library     | kind    | points in | points drawn | first frame ms | DOM nodes | max task ms | heap MB | verdict |
| ----------- | ------- | --------- | ------------ | -------------- | --------- | ----------- | ------- | ------- |
| echarts     | line    | 100000    | 4000         | 81             | 6         | 50          | 0.6     | PASS    |
| echarts-raw | line    | 100000    | 100000       | 106            | 6         | 76          | 27.7    | PASS    |
| echarts     | scatter | 50000     | 50000        | 77             | 7         | 0           | 11.1    | PASS    |
| uplot       | line    | 100000    | 100000       | 30             | 23        | 0           | -1.5    | PASS    |
| uplot       | scatter | 50000     | 50000        | 108            | 23        | 61          | -3.7    | PASS    |
| lwc         | line    | 100000    | 100000       | 120            | 30        | 60          | 40.8    | PASS    |
| recharts    | line    | 100000    | 100000       | 919            | 95        | 909         | 97.7    | FAIL    |
| recharts    | scatter | 50000     | 50000        | 2459           | 150082    | 2334        | 414     | FAIL    |

Raw: `NEARESIS_Build_Bible/reports/TESTS/UI-DESIGN/chart-benchmark.json`.

Reading the table:

- ECharts passes every threshold with large margins, even with 100k undownsampled points (`echarts-raw`). With the declared min/max bucket downsampling the line draws 4,000 points in about 100 ms and the DOM is 6 nodes. Downsampling is still required by the spec because it keeps the browser light on weak machines and keeps C18's "method visible" rule meaningful.
- uPlot is the fastest on lines and also passes, but it only offers line/area, so it cannot be the only library.
- lightweight-charts passes lines but has no scatter, category bar or heatmap series, and its heap cost is the highest of the passing candidates.
- Recharts fails: a 100k line blocks the main thread for about 0.9 s (limit 250 ms) and the 50k scatter creates about 150,000 DOM nodes (limit 5,000), 414 MB of heap (limit 150) and a 2.3 s task. Method note: Recharts 3 needs `react-is` aligned with the React major; the harness pins `react-is@19.3.1`. An earlier run with the default `react-is@17` rendered nothing, so those numbers were discarded and the harness was fixed before the figures above were taken.
- Spike preservation is covered by unit tests of the downsampler (`packages/ui/test/chart.test.ts`: single-point spikes of 900 and -400 inside 100,000 points survive a 2,000-bucket reduction; null gaps survive).

## Decision

1. Keep ECharts. It is the only candidate that covers all declared kinds (line, area, bar, scatter, heatmap, candlestick), markArea and markLine for gaps and markers, brush and dataZoom for C13, a canvas renderer for the DOM bound, and a serialisable option object (no code needed from specs). It already carries the C01 to C18 evidence in apps/web, so switching would invalidate recorded acceptance evidence.
2. Replace the full `echarts` import with the modular `echarts/core` build (`packages/ui/src/chart/echarts-core.ts`): only the five chart types, grid, tooltip, legend, markArea, markLine, dataZoom (inside), brush, toolbox (required by brush), visualMap (continuous) and the canvas renderer. This reduces the shipped bundle and removes SVG, 3D and unused series.
3. Theme through tokens, not through an ECharts theme JSON: `buildOption` reads CSS custom properties (`readChartTheme`) so light and dark share one source of truth and the chart re-themes when `data-theme` flips.
4. The renderer stays a pure function from a declared spec to plain data; a unit test asserts there is no function anywhere in the option.
5. Tooltips keep `renderMode: "richText"` (text drawn on canvas).
6. uPlot: revisit only if a product need appears for more than about 1 million points or sub-frame streaming; it would be wrapped behind the same `ChartSpec`.

## Consequences

- apps/web keeps `RENDERER_VERSION`-style provenance; phase 2 bumps it to `echarts-6.1.0/ui-theme-1` because option contents change.
- The DOM, heap and task thresholds are still verified by the real C18 run in apps/web after integration; this benchmark does not replace it.
- Risks: ECharts canvas text is not selectable and not read by assistive tech; mitigated by the hidden text alternative and live region in `Chart`.
