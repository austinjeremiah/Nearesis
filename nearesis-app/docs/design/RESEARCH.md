# Research notes: charts, motion, design-system patterns

Agent A12, 2026-11-10. Web searches were run with the built-in search tool; the sources are mostly blog posts and vendor material, so they are used for orientation only. Every performance claim that drives a decision was re-measured locally (see `ADR-CHARTS.md` and `NEARESIS_Build_Bible/reports/TESTS/UI-DESIGN/chart-benchmark.md`). No Reddit, Hacker News or dev.to thread turned up in the search results for the chart question, so no forum claim is relied on; the dev.to item below is a vendor-style roundup and is labelled as such.

## 1. Dynamic chart frameworks (React, 2026)

What the sources say, and how much weight it gets:

| Library                                   | What the sources report                                                                                                                                                                                                                                                     | Weight                                                       | Fit for Nearesis rules                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apache ECharts 6.x                        | Consistently named the choice for large and real-time datasets; canvas renderer; 100k+ points; broadest chart set (heatmap, candlestick, markArea, brush). ~1 MB full bundle, modular imports reduce it. 6.0 added dynamic theme registration and switching, scatter jitter | Several secondary sources agree                              | Option objects are plain JSON, no code needed from specs: matches C02/C10. Already used by apps/web, so C01/C14/C16 evidence stays valid                                                                                                   |
| uPlot 1.6.32                              | ~9 ms for a 100k-point line in a competitor's benchmark; author claims 166,650 points in 25 ms; under 50 KB. Time-series line/area only; no first-class scatter, no heatmap, no candlestick                                                                                 | Vendor-authored and author-authored numbers; not independent | Excellent for dense lines, but cannot cover the declared chart kinds alone                                                                                                                                                                 |
| TradingView lightweight-charts 5.2.1      | Financial charts on canvas; line, area, candlestick, histogram, baseline series                                                                                                                                                                                             | Directory entries only; no benchmark found                   | Finance only; no bar-by-category, scatter or heatmap                                                                                                                                                                                       |
| Recharts 3.10.1                           | Easy API; SVG, so one DOM node per point; practical range quoted at 1,000 to 5,000 points                                                                                                                                                                                   | Several secondary sources agree                              | Fails the DOM bound by construction for large series (confirmed locally)                                                                                                                                                                   |
| visx                                      | Low-level SVG building blocks; most control, no dataset-size rating found                                                                                                                                                                                                   | Secondary                                                    | SVG: same DOM-bound problem for large series; also means writing every chart ourselves                                                                                                                                                     |
| Nivo, Observable Plot, Vega-Lite, deck.gl | Appeared in roundups; not benchmarked here                                                                                                                                                                                                                                  | Not evaluated                                                | Nivo and Plot are SVG-first; Vega-Lite specs are declarative (a plus for C02) but its runtime evaluates expression strings, which conflicts with the no-formatter rule; deck.gl is a GPU map/3D layer, out of scope for 2D business charts |

Sources:

- [Best React Chart Library in 2026: 7 Top Options Compared (FusionCharts)](https://www.fusioncharts.com/blog/best-react-chart-library/) (vendor)
- [8 Top React Chart Libraries for Data Visualization in 2026 (Querio)](https://querio.ai/articles/best-react-chart-libraries-data-visualization)
- [Top 8 React chart libraries (LogRocket)](https://blog.logrocket.com/top-8-react-chart-libraries)
- [Top 7 React chart libraries for 2026 (dev.to roundup)](https://dev.to/basecampxd/top-7-react-chart-libraries-for-2026-features-use-cases-and-benchmarks-412c)
- [What is the best React based charting library for large datasets (dev.to)](https://dev.to/lodhi_ce8730c8129d8b0f508/what-is-the-best-react-based-charting-library-for-interactive-plots-with-large-datasets-16gn)
- [100,000 Points: A JavaScript Chart Rendering Benchmark (ApexCharts, competitor-run)](https://apexcharts.com/blog/javascript-chart-library-benchmark/)
- [My thoughts on the uPlot charting library (cprimozic.net)](https://cprimozic.net/notes/posts/my-thoughts-on-the-uplot-charting-library/)
- [uPlot repository mirror](https://gitee.com/mirrors/uPlot)
- [Best Apache ECharts alternative in 2026 (LightningChart, competitor)](https://lightningchart.com/blog/best-apache-echarts-alternative-in-2026/page/398/)
- [React charting library performance at scale (LightningChart, competitor)](https://lightningchart.com/blog/react-charting-performance/page/408/)
- [Apache ECharts 6 new features](https://echarts.apache.org/handbook/en/basics/release-note/v6-feature) and [v6 upgrade guide](https://echarts.apache.org/handbook/en/basics/release-note/v6-upgrade-guide)

Local benchmark (design lab, production build, headless Chromium, frozen C18 thresholds): see ADR-CHARTS.md. Short version: ECharts with min/max bucket downsampling and uPlot both pass comfortably; Recharts fails; lightweight-charts passes for lines but cannot draw scatter, bars by category or heatmaps.

## 2. Animation approaches

| Approach                                                                         | Notes from sources                                                                                                                                                                                       | Decision                                                                                                                                  |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Motion (the successor to framer-motion; package `motion`, import `motion/react`) | Springs, gestures, layout animations that animate with transforms, interruptible. Docs also offer a `spring()` helper that generates a CSS `linear()` easing for plain CSS                               | Used for the two moments that benefit from springs and mount/unmount: the approval card and the chat run card. Pinned `motion@14.9.1`     |
| CSS transitions and keyframes                                                    | Cheapest, compositor-friendly; no spring easing natively                                                                                                                                                 | Default for everything else (panel enter, patch ring, sidebar collapse, tooltips, palette). Durations and easings are tokens              |
| View Transitions API / React `<ViewTransition>`                                  | Good for route and full-view swaps; transitions are not interruptible (Motion docs). One source says React 19.3 made `<ViewTransition>` stable on 9 September 2026; unverified against React's own notes | Not used in phase 1. Candidate for route changes in phase 2 once verified; must degrade to no animation                                   |
| Reduced motion                                                                   | Browsers expose `prefers-reduced-motion`; Motion also has a reduced-motion setting                                                                                                                       | All tokens collapse to 0.01 ms; looping animations stop; chart animation off; a `data-motion="reduced"` switch exists for demos and tests |

Sources:

- [React ViewTransition vs Motion: comparing animation approaches (LogRocket)](https://blog.logrocket.com/react-viewtransition-vs-motion-comparing-animation-approaches/)
- [Motion: React AnimateView docs](https://motion.dev/docs/react-animate-view)
- [Motion: spring as CSS easing](https://motion.dev/examples/react-css-spring)
- [Practical guide to animation in React (GitNation)](https://gitnation.com/contents/practical-guide-to-animation-in-react)

## 3. Design-system patterns

- Semantic CSS custom properties (`--surface`, `--fg`, `--accent`) with the dark theme overriding the same names in a `[data-theme="dark"]` block is the common convention in shadcn/ui-style systems. Nearesis follows it, with two additions: dark also applies through `prefers-color-scheme` unless the user forced light, and chart colours are tokens (`--s1`..`--s6`) read by the chart theme at runtime.
- Radix primitives remain the safest accessible base (Dialog, Tooltip, Tabs, ScrollArea); shadcn/ui now also supports Base UI as the primitive layer (sources disagree on the date, December 2025 to February 2026). We use Radix directly through a thin set of our own wrappers rather than copying shadcn component files, because shadcn's Tailwind setup is not used in this repo and copied files would add unpinned conventions. The `cmdk` package (the command palette Radix-compatible primitive behind shadcn's Command) is used for the palette.
- One source recommends mapping shadcn's variable namespace onto an existing token system when you have one; since Nearesis has its own namespace (`nz-` classes, `--surface`...), nothing is mapped.
- Colour spaces: OKLCH is popular in current theming guides; we kept sRGB hex because every pair is contrast-checked by a unit test that needs plain hex, and the chart library consumes hex.
- Sources: [ADR: shadcn/ui as component foundation (third-party)](https://docs-viewer-11v.pages.dev/en/docs/a2r-workspaces/architecture/adr/011-shadcn-ui), [shadcn/ui vs Base UI vs Radix 2026 (PkgPulse)](https://www.pkgpulse.com/guides/shadcn-ui-vs-base-ui-vs-radix-components-2026), [shadcn/ui theming guide (dev.to)](https://dev.to/yigit-konur/the-complete-shadcnui-theming-guide-a-practical-approach-with-oklch-to-make-it-looks-10x-more-2l4l), [Vercel Academy: shadcn/ui core concepts](https://blog.vercel.com/academy/shadcn-ui/core-concepts.md).

## 4. Mobbin research

Mobbin was queried through the MCP tools `search_screens` and `search_flows` (web platform). No result carried an `ai_usage_notice`, so there is no notice text to reproduce. All 22 cited screens are saved in `docs/design/refs/` and listed with their `mobbin_url` in `refs/README.md`; DESIGN_SPEC.md cites each where it informs a decision. Queries used:

1. "Linear app sidebar navigation with workspaces and projects"
2. "AI assistant chat side panel next to a data workspace"
3. "command palette search dialog"
4. "analytics dashboard with chart cards and line chart tooltip"
5. "AI agent run steps timeline with tool calls and status"
6. "empty state for a dashboard with call to action"
7. Flow: "AI agent approval request approve reject action" (screens from the Vercel and Langdock flows were reviewed; not cited because they are marketplace and configuration screens, not run approvals; the approval card was designed from the API contract rather than copied)

Mobbin screens are used as inspiration for structure and density, not copied.
