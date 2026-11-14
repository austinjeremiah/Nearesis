# Phase 2 integration plan (apps/web)

Owner of phase 2: the lead, after A9 finishes. Source of truth for design: `DESIGN_SPEC.md`. Preview: `pnpm --filter @nearesis/design-lab dev` (127.0.0.1:3400).

## Status of `packages/ui`

- READY (typechecked, 41 unit tests, axe clean in the lab): tokens light/dark (`styles/tokens.css`), primitives (Button, IconButton, Badge, StatusDot, Kbd, Tooltip, Skeleton, Meter, icons), `AppShell`, `Sidebar`, `TopBar`, `CommandPalette`, `PanelCard` + badges (`FreshnessBadge`, `CompletenessBadge`, `PanelStateBadge`, `ProvenanceChip`, `UnitsBadge`, `PanelNotice`, `Inspector`), `DataTable`, states (`EmptyState`, `ErrorState`, `InvalidSpecState`, `ChartSkeleton`, `WorkspaceOnboarding`, `HonestyBanner`), `Chart` + `buildOption` + modular ECharts + `minMaxBucket`, `EvidenceGraphView`, `AgentChatPanel`, `RunTimeline`, `ApprovalCard`, `AbstentionCard`, `CitationChip`, `ProposedPanels`, motion hooks.
- PARTIAL: `Sidebar` investigations and sources lists (UI done; no list endpoints exist, see gaps); budget meters (totals only, no usage in `GET /v1/runs/:id`); `Button`/`IconButton` still use `forwardRef`; `motion` used only in `ApprovalCard`; the last full e2e run completed (16 checks ok, axe 0 serious or critical over 32 page states).
- MISSING: workspace switcher menu, user menu, settings and reports pages, chart legend click-to-toggle styling beyond ECharts default, manual screen-reader pass, adapter from apps/web inputs to `ChartSpec` (Step 3), event-to-`TimelineEvent` mapping (Step 4).

## Steps

Preconditions: A9 has finished and committed C01, C14, C16 evidence. Phase 2 owner edits only `apps/web` plus the lockfile. Work in small commits; run the existing acceptance suite after each step, not only at the end.

**Step 0. Baseline.** Record the current acceptance evidence commit and run `pnpm --filter @nearesis/web typecheck && pnpm --filter @nearesis/web test` so any later red can be attributed.

**Step 1. Wiring (no visual change yet).**

- `apps/web/package.json`: add `"@nearesis/ui": "workspace:*"`; `pnpm install`.
- `apps/web/next.config.ts`: add `"@nearesis/ui"` to `transpilePackages` (the package exports TypeScript source).
- `apps/web/src/app/layout.tsx`: `import "@nearesis/ui/styles.css"` before `./globals.css`. Verify `next build` resolves the `@fontsource` and `@xyflow/react` CSS imported from the package, and that the Next proxy CSP (`src/proxy.ts`) permits same-origin font files and inline style attributes (React, ECharts and React Flow use them). Do not add any external host (C10 scans `[href],[src]` for external references).
- Set `data-theme` from a small client toggle or leave it to `prefers-color-scheme`.

**Step 2. Panel chrome.** `src/components/Panel.tsx`: replace the outer `<section className="panel">`, header, meta row, notices and footer markup by `PanelCard` plus `FreshnessBadge`, `CompletenessBadge`, `ProvenanceChip`, `UnitsBadge`, `PanelNotice`, `Inspector`, `DataTable`. Keep all existing logic (cursor, crossings, `hooks()` writes, `Instantiated`). Selectors that must survive exactly (all are already emitted by the ui components): `panel-<id>` with `data-panel-kind` (pass `kind={panel.kind}`) and `data-panel-state`, `panel-title`, `panel-state` (text stays upper case, e.g. READY), `freshness` and `completeness` (**do not pass `age`**: C01, C07, C14 read `textContent` and expect the bare value), `source-label`, `units`, `provenance-toggle`, `select-mode`, `threshold-input`, `add-threshold`, `mark-range`, `stale-notice`, `error-notice`, `empty-state`, `chart-keyboard`, `cursor-live`, `watermark`, `downsampling`, `transform-label`, `threshold-crossings`, `gap-label`, `text-alternative`, `inspector`, `invalid-panel-<n>`, `chart-<panelId>` (the canvas host; `Chart` takes `testId`), plus `table.data td` (DataTable carries class `data`), `.markdown` (SafeMarkdown unchanged), `.react-flow__node` and `.react-flow__edge` with `data-id` (React Flow unchanged). The toolbar (select, threshold) stays in the DOM when hidden, so Playwright clicks still work; it reveals on hover, focus and selection. `InvalidPanel` becomes `InvalidSpecState` inside a `nz-panel` with `data-testid="invalid-panel-<n>"` and `data-panel-state="ERROR"`.

- Keyboard: `Chart` already implements the arrow, Shift and Enter cursor and the `cursor-live` region; delete the duplicate handler in `Panel.tsx` and wire `onKeyboardRange` and `onBrush` to the existing `select`.
- Alt+Arrow and Alt+Shift+Arrow `onKeyDown` stays on the `PanelCard` (it spreads rest props onto the `section`).

**Step 3. Chart.** `src/components/EChart.tsx` and `src/lib/chart-option.ts`: add an adapter `toChartSpec(panel, viz, data, gaps, markers)` that builds a `ChartSpec` from the same inputs `buildChartOption` takes today (kinds: timeSeries to line or area, bar and waterfall to bar, scatter, heatmap, candlestick; cohort stays as heatmap if that is what it is today). Keep `downsampleMinMax` from `@nearesis/canvas-schema` for the 8,000-point threshold and pass `downsampling` through so the footer label stays identical. Render `<Chart spec instanceRef onFirstFrame onBrush brushActive testId>`; in `instanceRef` keep `hooks().charts[panelId]`, and in `onFirstFrame` keep `hooks().firstFrameMs[panelId]` (C18 reads both). Retire `readPalette()` and the `Palette` prop (the chart reads tokens). Bump `RENDERER_VERSION` to `echarts-6.1.0/ui-theme-1` (selection provenance records it; C13 asserts the format, not the value, but confirm). The modular ECharts build in the ui package replaces the full `echarts` import: confirm C18 DOM, heap, first-frame and task numbers on the production build.

- If any acceptance test inspects the ECharts option (grep `getOption`, `series`), update the adapter, not the assertion. C02 and C10 must still show that no function or HTML reaches the option (the ui unit test already asserts it).

**Step 4. Shell and chat.**

- `src/app/w/[workspaceId]/page.tsx` and `Workspace.tsx`: wrap in `AppShell` with `Sidebar`, `TopBar`, `AgentChatPanel`; header keeps `document-revision`, `data-revision`, `mode-badge` (use `HonestyBanner` with that testid), `undo`, `redo`, `toast`. The canvas container becomes `<div className="nz-canvas">` (the shell supplies the one `main` landmark; remove the old `<main className="canvas-grid">`).
- `AskBox.tsx` becomes a store hook (`useRunConversation(workspaceId)`) feeding `AgentChatPanel`. Same requests as today: `POST /api/k/workspaces/:id/questions` with `Idempotency-Key`, body `{question, snapshotPolicy: "live", budget: {tokens: 60000, toolCalls: 16, usd: 1}}`; follow with `GET /api/k/runs/:id` on the existing 1 s poll and, for the live log, the existing `eventStore` SSE events (`run.state_changed`, `agent.spawned`, `task.started`, `task.completed`, `query.completed`, `canvas.patched`); load `GET /api/k/runs/:id/approvals` when the state is `APPROVAL_NEEDED`; decisions `POST /api/k/runs/:id/approvals/:approvalId` with `{decision, actionHash}`; cancel `POST /api/k/runs/:id/cancel`. Map `RunView`, `ApprovalView` and events to the ui types (they mirror the API). Keep the test ids `ask-input`, `ask-submit`, `run-status`, `ask-error`, and `hooks().run`. If `/api/k` does not proxy the approvals and cancel routes yet, extend the BFF catch-all (`api/k/[...path]/route.ts`) rather than calling the API from the browser.
- Sidebar and top bar: start with data already available in the web app (the current workspace, current run, source watermarks from `/api/semantic/watermarks`). Investigations and sources lists need data the API does not yet list; ask the lead whether to add a list route (see DESIGN_SPEC section 14). Do not invent endpoints.
- The fixture backend (`?scenario=`) must keep working with no kernel: the shell renders, the chat panel shows "Ask a research question" and the honesty banner states fixture mode.
- Open the dock by default only above 900 px (or when a run exists).

**Step 5. Styles.** Delete the superseded rules from `globals.css` (`.panel*`, `.badge*`, `.ws-header`, `.canvas-grid`, `.ask`, `.graph-node`, `.toast`, `.table`, tokens) once no selector in `apps/web` or its tests uses them. Class-based selectors used by tests are listed in Step 2; none are `.panel`, `.badge` or `.canvas-grid`, but grep `apps/web/test` once more before deleting.

**Step 6. EvidenceGraph.** `EvidenceGraph.tsx` keeps `checkProjection`, `NODE_TYPES`, `EDGE_RELATIONS`, unresolved list and `onLayout`; replace its node markup and edge styles with `EvidenceGraphView` styling (or import `EvidenceGraphView` and feed it the already-checked nodes and edges). `.react-flow__node[data-id]` and `.react-flow__edge` must remain (C16).

**Step 7. Verify.**

- `pnpm --filter @nearesis/web typecheck && pnpm --filter @nearesis/web test`.
- `pnpm --filter @nearesis/ui test` and `pnpm --filter @nearesis/design-lab e2e` (design lab still green).
- Rerun, in this order, the canvas acceptance tests that exercise the changed surface, each with `pnpm accept --id <ID> --session <agent>` after committing: **C01** (renders from spec), **C04** (reload persistence), **C05**, **C06**, **C07** (freshness text), **C08** (keyboard: Alt+Arrow, chart cursor, focus), **C09** (invalid panel isolation, instantiation log), **C10** (no external refs, no HTML from specs; new CSS and fonts must not trip the `[href],[src]` and `script` scans), **C11**, **C12** (markers, thresholds), **C13** (selection data space), **C14** (provenance inspector, freshness, completeness), **C15**, **C16** (graph), **C17** (gaps, no interpolation), **C18** (DOM, heap, first frame, task, state machine; production build, frozen reference environment; a changed environment makes it NOT_RUN, not FAIL). Also the `apps/web` unit tests and any A19/A20 run through the real API that touch the ask box.
- Capture before and after screenshots of `/w/fixture?scenario=baseline|gaps|graph|large|empty` into `reports/TESTS/UI-DESIGN/phase2/` and compare with the design lab shots.
- Re-run axe on the real app routes (fixture scenarios) with `@axe-core/playwright` (already a design-lab dependency); target 0 serious or critical.
- If any acceptance test fails, fix the implementation, never the assertion.

## Known gaps

- No budget usage on `GET /v1/runs/:id`; no investigations/sources list routes; run `result` panel payload not contract-defined (see DESIGN_SPEC section 14).
- Chart benchmark in `NEARESIS_Build_Bible/reports/TESTS/UI-DESIGN/chart-benchmark.md` is a library comparison, not a C18 run.
- `T-UI-REVAMP` is not on TASK_BOARD.json.
