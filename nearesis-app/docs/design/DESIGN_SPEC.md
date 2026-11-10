# Nearesis UI design specification

Owner: agent A12 (Engine A). Status: phase 1 complete (spec, `packages/ui`, `apps/design-lab`). `apps/web` is untouched; phase 2 integrates it (see `HANDOFF` and section 13).

- Live preview: `pnpm --filter @nearesis/design-lab dev` then http://127.0.0.1:3400 (all data SYNTHETIC; add `?theme=dark`, `?motion=reduced`, `?chat=closed`, `?sidebar=collapsed`, `?speed=12` to any route).
- Screenshots (light, dark, 1440 and 400 px, every screen): `NEARESIS_Build_Bible/reports/TESTS/UI-DESIGN/screenshots/`, indexed in `screenshots.json`.
- Mobbin references: `docs/design/refs/` with `mobbin_url` for every image in `refs/README.md`. They are cited below as `[ref: file]`.
- Companion documents: `SKILLS.md` (skills vetting), `RESEARCH.md` (chart and animation research), `ADR-CHARTS.md` (chart framework decision draft).

## 1. Design plan and review

Process taken from the `frontend-design` skill: plan, review the plan against the brief, then build.

**Subject and audience.** A research tool for analysts of NEAR Intents settlement data. They compare series, check provenance and decide what to trust. The primary job: ask a question, watch an agent work honestly, and keep verified panels on a canvas. Reference feel: Linear, Vercel, Hex. Dense, calm, quiet colour.

**Plan v1 (first pass).**

- Colour: warm off-white, a purple-to-blue gradient accent for the agent, soft shadows on rounded cards.
- Type: Inter 14 px.
- Layout: centred hero in the empty state, cards with equal 16 px radius, chat as a floating bubble.
- Chat: rounded bubbles with avatars and a "thinking" spinner.

**Review against the brief.** The brief says not AI-looking and not poor design. Plan v1 failed it on five counts, so it was revised:

| Plan v1                                     | Why it fails                                                                   | Revision                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purple gradient agent accent                | The most common generated-UI tell; and the agent is not the brand, the data is | No gradients anywhere. One blue accent used only for focus, selection and the primary action                                                                  |
| Warm off-white                              | Listed as a default tell                                                       | Cool neutral greys (`#f6f7f9` page, white cards); dark theme is a blue-grey, not black                                                                        |
| Inter                                       | Listed as a default                                                            | Geist Variable (UI) and Geist Mono Variable (hashes, queries), self-hosted                                                                                    |
| One radius, soft shadow on every card       | "SaaS-card kit"                                                                | Radius by role 3 / 5 / 8 / 12; cards use a 1 px border and no shadow; only overlays have a shadow                                                             |
| Centred hero, floating chat bubble, avatars | Centred-everything, chatbot cliche                                             | Left-aligned onboarding with three actionable steps; the agent is a docked panel with a run log, not bubbles. No avatars, no spinner: state is a dot and text |

**Final token plan.**

- Colour (named): Paper `#f6f7f9`, Card `#ffffff`, Ink `#14181f`, Slate `#4a5565` (muted text), Signal blue `#2456c8` (accent), Honesty violet `#5b4bb5` (SYNTHETIC and unattested only). Status: green `#17703f`, amber `#8a5a00`, red `#b3261e`. Series: blue, burnt orange, teal, magenta, olive, slate (section 5).
- Type: Geist Variable 13 px base, scale 11 / 12 / 13 / 14 / 16 / 20 / 26, weights 400 / 500 / 600, Geist Mono for hashes. Tabular numerals on every number.
- Layout: three columns, sidebar 248 (rail 52), canvas fluid, agent dock 392. Everything left-aligned.
- Principle: spend boldness in one place, the honesty tag (dashed edge, hatched fill). Everything else is quiet.

**Self-critique after building** is logged in section 12 (screenshots were reviewed and nine concrete changes made).

## 2. Tokens

Source of truth: `packages/ui/src/styles/tokens.css`. Light is default; dark applies through `prefers-color-scheme` unless `data-theme="light"` is set, or through `data-theme="dark"`. Both blocks are asserted equal by a unit test, and every text pair is asserted at WCAG AA by `packages/ui/test/tokens.test.ts`.

### 2.1 Colour

| Token                                           | Light                                                               | Dark                                    | Role                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `--bg`                                          | `#f6f7f9`                                                           | `#0e1116`                               | page                                                          |
| `--surface`                                     | `#ffffff`                                                           | `#151a21`                               | cards, topbar, dock                                           |
| `--surface-sunken`                              | `#eff1f4`                                                           | `#11151b`                               | sidebar, inputs, inspector                                    |
| `--surface-hover` / `--surface-selected`        | `#f1f3f6` / `#e8edf7`                                               | `#1b212a` / `#1d2a44`                   | hover, selected row                                           |
| `--border` / `--border-strong` / `--grid`       | `#dfe3e9` / `#c7cdd6` / `#e9ecf0`                                   | `#262d37` / `#343d4a` / `#222932`       | rules, chart grid                                             |
| `--fg` / `--fg-muted` / `--fg-subtle`           | `#14181f` / `#4a5565` / `#576272`                                   | `#e8ebf0` / `#9ba5b4` / `#8792a3`       | text; all at least 4.5:1 on every surface                     |
| `--accent` / `--accent-hover` / `--accent-soft` | `#2456c8` / `#1d47a8` / `#e6edfb`                                   | `#7ba3ff` / `#98b6ff` / `#1b2744`       | focus, selection, primary action only                         |
| `--ok` `--warn` `--bad` `--info` (+ `-soft`)    | `#17703f` `#8a5a00` `#b3261e` `#2456c8`                             | `#5fcf8f` `#e5b659` `#ff8a80` `#7ba3ff` | status text on soft fill, at least 4.5:1                      |
| `--honesty` (+ `-soft`)                         | `#5b4bb5`                                                           | `#aea1f0`                               | SYNTHETIC and unattested labels only; never reused for status |
| `--s1`..`--s6`                                  | `#2f62c9 #b8650c #167a6c #b13a72 #6d6a1a #576272`-family (see file) | lighter set                             | chart series, at least 3:1 on the card                        |
| `--gap` `--marker` `--up` `--down`              | red wash 7%, `#5b4bb5`, green, red                                  | tuned                                   | gap shading, markers, candlesticks                            |

Rules: colour carries meaning (state, series, honesty) and nothing else. Status is never colour alone: every badge has text, and dots sit next to a label. Contrast measured by the unit tests, not by eye.

### 2.2 Type

| Token        | px  | Use                                                             |
| ------------ | --- | --------------------------------------------------------------- |
| `--text-2xs` | 11  | badges, footers, chart axis labels                              |
| `--text-xs`  | 12  | meta, kbd, captions                                             |
| `--text-sm`  | 13  | base UI text                                                    |
| `--text-md`  | 14  | panel titles, card titles                                       |
| `--text-lg`  | 16  | section headings in the lab                                     |
| `--text-xl`  | 20  | workspace heading, onboarding heading (letter-spacing -0.012em) |
| `--text-2xl` | 26  | lab page titles                                                 |

Line height 1.45 (loose 1.6 for answer prose). Prose never exceeds 62 characters per line (`max-width: 58ch` to `62ch`). Geist Variable for text, Geist Mono Variable for hashes, queries and codes (`.nz-mono`, `.nz-hash`). `font-variant-numeric: tabular-nums` on revisions, times, counters, tables, budgets.

### 2.3 Space, radius, shadow, layout

- Space (4 px base): 2, 4, 8, 12, 16, 24, 32, 48 (`--space-0`..`--space-7`).
- Radius by role: `--radius-xs` 3 (chips, kbd), `--radius-sm` 5 (controls), `--radius-md` 8 (cards, panels), `--radius-lg` 12 (palette, overlays), `--radius-pill` (badges).
- Shadow: only `--shadow-pop` (tooltips, palette, mobile drawers, toast). Cards, panels and the dock have no shadow, only a 1 px border.
- Layout: `--sidebar-w` 248, `--sidebar-w-collapsed` 52, `--topbar-h` 48, `--chat-w` 392. Canvas grid: 12 columns, 48 px rows, 12 px gap, 16 px padding.
- Z-index: sticky 10, overlay 40, toast 60.

### 2.4 Motion tokens

`--dur-instant` 80, `--dur-fast` 140, `--dur-base` 200, `--dur-slow` 320 (ms). Easings: standard `cubic-bezier(.2,0,0,1)`, enter `cubic-bezier(.16,1,.3,1)`, exit `cubic-bezier(.4,0,1,1)`. JS spring: stiffness 420, damping 34, mass 0.9 (`motionTokens.spring`). All durations become 0.01 ms under reduced motion.

## 3. App shell

```
+--------------+----------------------------------------------+-------------------+
| [N] NEAR In.v| NEAR Intents research / Canvas / Settlement  |  Ask            x |
| [ ]          | [ Search or run a command  K ] Run budget ## | ----------------- |
|--------------| Live  (moon) (chat)                          |  user message     |
| # Canvas     |----------------------------------------------|  +--------------+ |
|              | Settlement review   doc rev 14  data rev 3   |  | run card     | |
| Investigations| [ FIXTURE MODE banner, dashed, hatched     ] |  |  timeline    | |
|  o Solana..  | +-----------------------+ +---------------+  |  |  approval    | |
|  o Solver .. | | panel card            | | panel card    |  |  |  summary     | |
| Sources      | +-----------------------+ +---------------+  |  +--------------+ |
|  . Explorer 2m|  ...12-column grid, 48px rows               | [ composer     ] |
| Reports      |                                              |                   |
| Settings     |                                              |                   |
| PN Priya N.  |                                              |                   |
+--------------+----------------------------------------------+-------------------+
   248 / 52              fluid                                       392
```

Implemented by `AppShell`, `Sidebar`, `TopBar`, `CommandPalette`. Shot: `workspace.light.1440.png`, `workspace.dark.1440.png`, `sidebar-collapsed.light.1440.png`, `command-palette.light.1440.png`.

### 3.1 Sidebar (collapsible)

References: Linear [ref: linear-sidebar-issues, linear-sidebar-projects, linear-sidebar-customize]; Remote [ref: remote-agent-chat]; incident.io [ref: incidentio-empty-state] for grouped sections and a quiet selected row.

- Surface `--surface-sunken`, 1 px right border. Header 48 px: workspace switcher (mark, name, chevron) and the collapse button (`[` shortcut label in tooltip).
- Groups, in order, with plain sentence-case 12 px muted labels (no caps, no counts unless useful): Canvas; Investigations (title plus a run-status dot); Sources (name, freshness dot, age such as `41m`); Reports; Settings. Footer: avatar initials, name, email.
- Run status dot mapping from `RunState`: REQUESTED, PLANNING, EXECUTING, EVIDENCE_REVIEW, CANVAS_PATCH_REVIEW = blue pulsing; APPROVAL_NEEDED = amber pulsing; COMPLETE = green; PARTIAL = amber; BLOCKED = red; CANCELLED = grey. The status label is in the DOM as screen-reader text and in the item's accessible name.
- Selected row: `--surface-selected` fill, a 2 px accent bar on the left edge, medium weight. No glow.
- Collapsed: 52 px icon rail, labels hidden, each icon has a Radix tooltip on the right and an accessible name that still includes the title and status. Width animates 320 ms standard ease through the grid column.
- Below 760 px the sidebar is a drawer from the left with a scrim; opened by the menu button in the top bar, closed by the scrim or navigating.
- Keyboard: Tab through items, Enter activates; `aria-current="page"` marks the active one; the nav is a landmark named "Primary".

### 3.2 Top bar

48 px, `--surface`, bottom border.

- Left: breadcrumbs (`nav aria-label="Breadcrumb"`, ordered list, current page `aria-current`), earlier crumbs are ghost buttons.
- Centre-right: the search trigger (visible text "Search or run a command", `K` hint with Meta/Ctrl) opens the palette; `aria-keyshortcuts` declared.
- Run and budget indicator (shown only while a run is active): label, a 56 px meter that turns amber at 70% and red at 90%, and `used/total tokens` in tabular numerals. Meter is `role="meter"`.
- Live connection state: dot plus text from `ConnectionState`: Live (green), Reconnecting (amber, pulsing), Offline (red), Reload required (amber). It reflects the SSE stream: `reload_required` frames (INVALID_CURSOR, CURSOR_EXPIRED) map to "Reload required".
- Theme toggle and agent-panel toggle (`aria-pressed`). Undo and redo live in the workspace header, not here.

### 3.3 Command palette

References: Luma, Stripe, incident.io [ref: luma-command-palette, stripe-command-palette, incidentio-command-palette].

- Opens with Meta+K or Ctrl+K (`useCommandPaletteShortcut`), closes with Escape. Radix Dialog (focus trap, return focus) with `cmdk` for filtering and arrow navigation, looping.
- 600 px wide, 12 px radius, `--shadow-pop`, scrim 32% (55% dark). Entry: 200 ms fade plus 6 px rise and 98.5% scale to 100%, enter easing.
- Groups: Agent (ask), Canvas (undo, redo), Panels (go to panel), Investigations (open run, hint = state). A hint column on the right, shortcut keys as `kbd`. Footer line with key hints (up, down, enter, esc), hidden from assistive tech.
- Empty result text: "No results. Try a panel name, a run, or "ask"."
- Every command is a plain object `{id, label, group, run}`; nothing is evaluated from data.

## 4. Workspace canvas

Reference: Searchable, Sprig, Base44, incident.io insights, Snowflake [ref: searchable-visibility-line-card, sprig-area-chart-tooltip, base44-analytics-area-tooltip-chat, incidentio-insights-bar-tooltip, snowflake-version-history-panel].

### 4.1 Header and banner

Workspace title (20 px semibold), `doc rev` and `data rev` (tabular, muted), spacer, Undo and Redo icon buttons with `Cmd+Z` and `Shift+Cmd+Z` in the tooltips. In fixture or synthetic mode a full-width **honesty banner** sits under the header: dashed violet border, hatched fill, text "Fixture mode: every number here is SYNTHETIC and unattested. Nothing is production data." It is not dismissible. (`HonestyBanner`)

### 4.2 Panel card (`PanelCard`)

```
+---------------------------------------------------------------+
|:: Settled volume                              . ready   (...) |  header: grip (hover), title, state, actions
| . fresh  partial  [SYNTHETIC unattested]  units: x=USD m  Prov. |  meta row
| [Select range] [Add threshold]                                  |  toolbar (hover, focus, selected)
| ( notice: stale or error )                                      |
|  chart / table / note / graph                                   |  body, fills the grid cell
| watermark ..  gaps shaded, not interpolated: 1  downsampling .. |  footer, 11 px tabular
| ( provenance inspector, expands )                               |
+---------------------------------------------------------------+
```

- Surface: `--surface`, 1 px `--border`, radius 8, no shadow. Hover: `--border-strong`. Selected: accent border plus 1 px accent ring. Error: red border.
- Header: drag grip appears on hover or focus-within (absolute, so the title stays aligned with the meta row); title 14 px semibold, wraps; state badge. A READY panel shows quiet text with a green dot (no pill); STALE, REFRESHING, QUERYING, VALIDATING, ERROR show pills (pulsing dot while busy).
- Meta row, in order: freshness badge (text plus age), completeness badge, provenance chip, units (plain text, no pill), provenance toggle button.
- Toolbar (range select, threshold input, add threshold, mark selection) is collapsed by default and reveals on hover, focus-within or selection with a 200 ms opacity and height transition; on touch devices (`hover: none`) it is always visible. It stays in the DOM, so keyboard users reach it with Tab and tests can click it.
- Notices: stale (amber), error (red, `role="alert"`), honesty (violet). Footer carries watermark, downsampling method and counts, transform labels, threshold crossings, gap label.
- Provenance inspector: monospace JSON in a sunken block that expands with a 200 ms rise. Contains the same fields apps/web shows today (queryHash, semanticVersion, semanticModelHash, sourceSnapshotId, rawManifestHash, certification, resultHash, sourceLabel, ast).
- Text alternative: visually hidden paragraph (`data-testid="text-alternative"`).
- Placement: `grid-column: x+1 / span min(12,w)`, `grid-row: y+1 / span h`, exactly as today.
- Selection: click selects (accent ring). Keyboard: panel is focusable (`tabIndex=0`); Alt+Arrow moves, Alt+Shift+Arrow resizes (existing behaviour, unchanged).
- Patch applied: when `documentRevision` or `dataRevision` changes for the panel, a 2 px accent inset ring appears at 90% and fades over 1.4 s (`data-flash`), once.
- Enter: panels created by an agent run play a 320 ms enter (opacity from 0, 6 px rise, 99% scale) via `entering`.

### 4.3 Other panel kinds

- Table: `DataTable`, sticky header, tabular figures, numbers right aligned, missing = em dash, first 500 rows.
- Note: safe markdown (apps/web `SafeMarkdown`, unchanged) at 58 ch.
- Evidence graph: `EvidenceGraphView` (React Flow, themed). Nodes are 180 px max, white card with a 3 px left bar whose colour encodes node kind (hypothesis blue, observation teal, query and source grey, model olive, marker violet, agent magenta). Edges: `contradicts` red dashed, `reproduces` green, `supersedes` amber dashed, `derived_from` dotted, `monitors` long dash, `supports` and `references` solid; relation names on edge labels, so the graph also reads in greyscale. Default layout columns by kind when no stored position exists. Dragging a node reports positions through `onLayout` (existing `graph.save_layout`). Unresolved edges stay a list outside the graph (existing behaviour, C16).
- Invalid stored spec (C09b): isolated card, "This panel was not rendered", issue codes; never instantiates a component.

### 4.4 Undo, redo, layout editing

Undo and redo are icon buttons in the workspace header with disabled states; Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z unchanged. Layout editing affordances: the grip, Alt+Arrow move, Alt+Shift+Arrow resize, a toast for conflicts (`409` "Conflict", rejected patches with issue codes). Toast: bottom right, red left border, `role="alert"`.

### 4.5 Markers

Time-range markers are violet bands (13% opacity) labelled at the top; threshold markers are dashed violet lines with a value label; point markers are dashed vertical lines. Threshold crossing counts appear in the panel footer. Gaps are red-tinted bands (7%) with a "missing: reason" label, and the line breaks (never interpolated).

## 5. Chart system

Implementation: `packages/ui/src/chart/` (`buildOption.ts`, `theme.ts`, `Chart.tsx`, `echarts-core.ts`). Decision and benchmarks: `ADR-CHARTS.md`.

### 5.1 Hard rules (C02, C10, C18)

- The canvas renders only a declared `ChartSpec` (data). `buildOption` returns plain JSON; a unit test walks the whole option and fails if any function exists. There are no formatter functions and no HTML. Tooltips use `renderMode: "richText"`, which draws text on the canvas, so labels and series names cannot become markup (a test passes `<img onerror>` as a title).
- Canvas renderer only: the DOM stays at about 6 nodes per chart (benchmark) against a 5,000 ceiling.
- Large series: min/max bucket downsampling (spike-preserving), declared in the spec (`downsampling.method`) and shown in the panel footer.
- Animation is off above 2,000 points and under reduced motion.

### 5.2 Palettes (light / dark), colour-blind safe, at least 3:1 on the card

| Series         | Light     | Dark      |
| -------------- | --------- | --------- |
| 1 blue         | `#2f62c9` | `#6e9bf2` |
| 2 burnt orange | `#b8650c` | `#f0a24f` |
| 3 teal         | `#167a6c` | `#4cc2b0` |
| 4 magenta      | `#b13a72` | `#ea7fae` |
| 5 olive        | `#6d6a1a` | `#c8c35a` |
| 6 slate        | `#576272` | `#9ba5b4` |

Blue and orange are the first two so the most common pair (deuteranopia, protanopia) stays separable by hue and luminance; series are also distinguished by marker and dash where more than two are drawn (legend swatch is a 10 x 3 bar). Candlesticks use green up and red down with identical fill style, plus the body shape (filled vs wick) as the second cue. The heatmap uses one hue ramp from `--grid` to series 1, so it reads by lightness. The evidence graph uses edge dash patterns in addition to hue.

### 5.3 Typography and axes

Axis and legend text: Geist 11 px, `--fg-muted`. No axis names (units live in the series name, for example `intents.settled_volume (USD m)`, and in the panel meta). y axis: no axis line, 1 px `--grid` splits. x axis: 1 px `--border` line, no ticks, `hideOverlap`. Grid insets: left 52, right 16 (52 with a second axis), top 24 (34 with a legend), bottom 28.

### 5.4 Per kind

- Line: 1.75 px, symbols only up to 80 points, `connectNulls: false`.
- Area: line plus 12% fill.
- Bar: max width 26 px, 2 px top radius, single hue unless multi series.
- Scatter: 3 px symbols at 70% opacity, `large` mode above 2,000.
- Heatmap: 2 px radius cells with a 1 px card-colour gap, continuous `visualMap` legend (10 x 120).
- Candlestick: up and down colours from `--up` and `--down`.
- Table and evidence graph: sections 4.3.

### 5.5 Tooltip

Card surface, 1 px border, 8 x 10 padding, text 12 px `--fg`, axis pointer is a 1 px dashed muted line (no pointer label), confined to the chart. No shadow because it is drawn on canvas. Multi-series axis tooltips list every series at the pointer. Content comes from the data only.

### 5.6 Interaction

Wheel zoom and drag pan on time axes (inside dataZoom, no document revision change); select-range mode uses a brush that reports data-space UTC ms (C13); keyboard cursor (arrows, Shift extends, Enter commits, Escape clears) with a live region ("2026-10-12T00:00: 4.2 USD m").

### 5.7 Refresh transitions

Data refresh merges into the existing chart with a 260 ms cubic-out tween (`animationDurationUpdate`); if the series set changes the chart replaces instead. A panel in REFRESHING keeps its last good data on screen.

## 6. Agentic chat box

References: Luma, Miro, Wix, Plane, Remote, Searchable, incident.io run drawer [ref: luma-canvas-chat-dock, miro-chat-add-to-canvas, wix-aria-planning, plane-ai-answer-table, remote-agent-chat, searchable-agent-thinking, incidentio-run-steps-drawer].

The chat is a docked right panel (392 px), not a floating bubble. It is a controlled component: the app passes the thread, the run models, and callbacks. It uses only the existing API:

| UI action     | Existing API                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask           | `POST /v1/workspaces/:id/questions` body `{question, snapshotPolicy, budget}` with `Idempotency-Key`; response `{runId, workflowId}` (202)                                                                                                              |
| Follow a run  | `GET /v1/runs/:id` (poll as today) returns `{runId, workspaceId, state, terminal, version, failure, result, rootTask, children[], evidenceLinks[]}`                                                                                                     |
| Live events   | `GET /v1/workspaces/:id/events` SSE; frames named by type: `run.state_changed`, `agent.spawned`, `task.started`, `task.completed`, `query.completed`, `canvas.patched`, `approval.granted`, `approval.rejected`, plus `coalesced` and `reload_required` |
| Approvals     | `GET /v1/runs/:id/approvals[?status=all]`; `POST /v1/runs/:id/approvals/:approvalId` with `{decision: "approve"                                                                                                                                         | "reject", actionHash}` |
| Cancel        | `POST /v1/runs/:id/cancel` with `{expectedVersion?}`                                                                                                                                                                                                    |
| Add to canvas | the composer's panels arrive as committed canvas patches over SSE (A7: "panels arrive as committed canvas patches"). "Add to canvas" is a client command through the existing `/commands` patch path; it is a button on the proposed-panels card        |

No endpoint is invented. Two gaps are recorded in section 14 (budget usage, proposed-panel payload).

### 6.1 Layout

```
+ Ask                                         x +
|                      +----------------------+ |
|                      | Did solver fill ...  | |  user message (right, sunken tint)
|                      +----------------------+ |
| +-------------------------------------------+ |
| | . Needs your approval   7c1f0a52  [Cancel]| |  run header: state dot, label, short id
| |-------------------------------------------| |
| |  o Requested                              | |
| |  o Planning  Splitting the question ...   | |  timeline (grey earlier, colour on current)
| |  Y Director  Plan fill-rate checks        | |
| |     Y Semantic analyst  Fill rate by ...  | |  child agent, indented
| |  <> Query solver.fill_rate  [LIVE certified]| |
| |     124 rows . b41d0c7e92                 | |
| |  [ Cannot compute solver.volume_share ]   | |  abstention card (dashed)
| |  [ Approval needed: action, network, cost,| |
| |    action hash sha256:..  [Reject][Approve]| |
| |  streaming summary text|                  | |
| |  (Fill rate by chain b41d0c7)(Settled .)  | |  citation chips
| |  [ Panels from this run   Add to canvas ] | |
| |  Tokens  ####....  21,400 / 60,000        | |  budget
| +-------------------------------------------+ |
| [ Ask a question about NEAR Intents         ] |  composer
| [ Budget per question: 60k, 16 calls, $1  Ask]|
```

Shots: `workspace-approval.*`, `workspace-complete.*`, `workspace-blocked.*`, `chat-live-approval.light.1440.png`, `chat-live-complete.light.1440.png`.

### 6.2 Run log (timeline)

Each row is one SSE-derived event, appended in order with a 200 ms enter; rows already shown never move. Rows:

- State (from `run.state_changed`): label from `RUN_STATE_LABEL` (Planning, Needs your approval, Running, Reviewing evidence, Preparing panels, Complete, Partial result, Blocked, Cancelled). Only the current or final state is coloured (pulsing dot while running); earlier states recede to grey.
- Agent (from `agent.spawned`, `task.started`): role name and objective, branch icon; child agents (`parentTaskId` set) indent 16 px. Max depth is 3 in the contract.
- Query (from `query.completed`): metric, row count, short query hash, and a provenance chip (LIVE certified, or the dashed unattested tag when `certification` is experimental).
- Abstention (cannot_compute): its own card (below), not a red error.
- Approval, and Panel rows ("Proposed panel X", "Added panel X").

### 6.3 Approval card (`ApprovalCard`)

Shown for the current pending approval from the approvals route. Contents: kind, network, cost limit, and the **full action hash** in mono. Buttons Reject (danger) and "Approve action" (primary) call `onDecide(approval, decision)`; the app POSTs `{decision, actionHash: approval.actionHash}` using the hash shown. Copy under the hash: "Approving authorises exactly this action. If the plan changes, the hash changes and this request is replaced." If the server answers `ACTION_HASH_MISMATCH` or `APPROVAL_NOT_PENDING`, the card re-reads the approval list and the replaced request shows as Superseded (muted, no buttons). Decided approvals stay below the answer as Approved or Rejected history. The enter animation is a spring (stiffness 420, damping 34); with reduced motion it appears instantly.

### 6.4 Abstention card

Dashed border, sunken fill, title "Cannot compute <metric>", the reason, and one sentence on what it does and does not affect. Abstention is a result, not a failure; the run state may end PARTIAL (the director stops spawning after a `cannot_compute`).

### 6.5 Answer, citations, add to canvas

The summary streams word by word with a blinking caret (static caret under reduced motion); it renders as text only. Citation chips show label plus a 7-character query hash; click opens the panel or provenance for that query hash. The proposed-panels card lists panels with "Add to canvas" (button disables for 600 ms, then the row shows "on canvas"). Nothing lands on the canvas until the user adds it. A failure shows reason code, human action needed and the replay command (from `RunFailure`).

### 6.6 Budget

Three meters (tokens, tool calls, cost) per run card, and the top-bar indicator. Submitted budget is known (`SubmitQuestionRequest.budget`); usage is not exposed by `GET /v1/runs/:id`, so meters show "of N" without a bar until the API returns usage (section 14).

### 6.7 Composer

Textarea (max 4000), Enter sends, Shift+Enter newline, IME composition respected. Send is disabled while a run is active (matches the existing behaviour) and while empty. Server errors render verbatim in an alert above the box: "422 INVALID_BODY Invalid request body." The existing test ids are kept: `ask-input`, `ask-submit`, `run-status`, `ask-error`.

### 6.8 Scrolling and announcements

The log sticks to the bottom unless the user scrolled up. The scroll region has `role="log"`; the streaming summary is `aria-live="polite"`; the timeline itself is not announced row by row (state changes are announced through the status text in the run header).

## 7. States

| State                | Treatment                                                                                                                                                                                                                              | Shot                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Empty workspace      | Left-aligned onboarding: h1 "This workspace is empty", one sentence, three actionable step cards (Ask a question, Check the sources, Pin what holds up). [ref: incidentio-empty-state, plane-empty-dashboard, klaviyo-empty-dashboard] | `workspace-empty.*`   |
| Loading              | Chart-shaped skeleton with fixed heights (no layout shift), shimmer 1.6 s (stops under reduced motion), `role="status"`                                                                                                                | `workspace-states.*`  |
| Querying, refreshing | Pill with pulsing dot; REFRESHING keeps last good chart visible                                                                                                                                                                        | `workspace-states.*`  |
| Stale or late        | Amber notice "Source is late: showing last good data from <watermark>"; freshness badge shows age                                                                                                                                      | same                  |
| Partial              | Completeness badge "partial"; gaps shaded and counted in the footer                                                                                                                                                                    | `workspace.*`         |
| Empty result         | "No rows for this query window. Nothing is plotted: an empty result is not a zero series." plus coverage, gaps, watermark                                                                                                              | `workspace-states.*`  |
| Error                | Red border, red notice with code and message, state with "Retry query"; last good data stays if it exists                                                                                                                              | same                  |
| Invalid stored spec  | Isolated card with issue codes                                                                                                                                                                                                         | same                  |
| Blocked, unattested  | Run blocked card with reason code, human action, replay; unattested data carries the dashed honesty tag                                                                                                                                | `workspace-blocked.*` |
| Connection           | Top bar: Live, Reconnecting, Offline, Reload required                                                                                                                                                                                  | `workspace-states.*`  |

Honesty labels (SYNTHETIC, unattested, stale) are never hidden: the SYNTHETIC tag is on every panel's meta row and in the banner; it is not in a menu and cannot be dismissed. Style: dashed 1 px violet border, 135 degree hatched fill, text label (so it still reads without colour).

## 8. Motion

Principle (from `frontend-design`): motion answers an action or marks a state change; no scroll-triggered entrances, no hover motion on every card. All motion has a reduced-motion fallback: tokens collapse to 0.01 ms (media query and the `data-motion="reduced"` switch), looping animations stop, ECharts animation is off, `motion` springs use duration 0. Verified by e2e (no running animation longer than 1 ms).

| Moment               | Trigger                           | Spec                                                                                                          | Reduced                          |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Panel enter          | agent adds a panel                | 320 ms enter easing, opacity 0 to 1, translateY 6 px to 0, scale .99 to 1                                     | none                             |
| Patch applied        | document or data revision changes | 2 px accent inset ring, 90% to 0 over 1.4 s, once                                                             | none                             |
| Streaming tokens     | answer streams                    | word by word at about 45 ms, blinking 7 px caret (1 s steps)                                                  | caret static, text still streams |
| Run-state transition | `run.state_changed`               | timeline row enters 200 ms (opacity, 4 px rise); dot colour changes; pulsing dot (1.8 s) only on the live row | no pulse, rows appear            |
| Approval card        | pending approval                  | spring 420/34, from opacity 0, 6 px, .99                                                                      | instant                          |
| Chart refresh        | new data                          | 260 ms cubic-out tween; first draw 320 ms; off above 2,000 points                                             | off                              |
| Sidebar collapse     | button                            | grid column 320 ms standard easing; labels hide                                                               | instant                          |
| Chat dock            | toggle                            | width 320 ms standard (desktop); slide 320 ms enter easing (below 900 px)                                     | instant                          |
| Palette              | open                              | 200 ms fade plus 6 px rise, scale .985 to 1; scrim fades 200 ms                                               | instant                          |
| Toolbar reveal       | hover, focus, select              | 200 ms opacity and max-height                                                                                 | instant                          |
| Tooltip              | hover                             | 140 ms fade plus 2 px rise                                                                                    | instant                          |
| Buttons              | hover, press                      | 140 ms colour, 0.5 px press                                                                                   | instant                          |

## 9. Accessibility

- Contrast: AA for all text pairs in both themes (unit-tested); chart series at least 3:1 on the card.
- Keyboard (C08): every control is a native button or link; the first Tab stop shows a 2 px focus ring with 2 px offset (`:focus-visible`, `--focus`; tested); panels focusable; Alt+Arrow and Alt+Shift+Arrow move and resize; chart cursor with arrows, Shift range, Enter select, Escape clear; palette focus trap and restore (Radix); Escape closes overlays; `aria-keyshortcuts` on the palette trigger.
- Charts: `role="group"`, `aria-roledescription="chart"`, label with instructions; canvas is `aria-hidden`; a hidden text alternative states units, min, max, missing count, gaps, downsampling; a polite live region reads the cursor value. Tables are real tables with `scope="col"`.
- Landmarks: nav "Primary", `main`, `aside` "Agent" (inert when closed), breadcrumb nav, one `h1` per screen.
- Icon-only buttons require an accessible name (the `IconButton` prop `label` is mandatory) and show a tooltip. Collapsed sidebar items keep their names.
- Status is never colour alone (text in every badge and in sidebar items).
- Reduced motion: section 8. Light and dark: both tested. Touch: toolbars always visible when hover is unavailable. Zoom and 400 px reflow: no horizontal page scroll (verified by screenshots).
- Automated: axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice) over 32 page states (8 screens, 2 themes, 2 viewports): 0 serious or critical (`axe-summary.json`). Automated checks do not replace a manual screen-reader pass; that is listed for phase 2.

## 10. Responsive

| Width         | Behaviour                                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1280 and up   | Sidebar 248 (or 52 collapsed), canvas fluid, dock 392                                                                                                                                                                                                                  |
| 901 to 1279   | Same; the dock may be closed to give the canvas room                                                                                                                                                                                                                   |
| 761 to 900    | Dock becomes a right overlay (slide, scrim)                                                                                                                                                                                                                            |
| 760 and below | Sidebar is a left drawer; canvas is one column, panels 320 px min height; search trigger is icon only (label kept for assistive tech); budget and connection hidden from the bar (the connection state remains reachable in the drawer in phase 2); dock is full width |

## 11. Component inventory (`packages/ui`)

Primitives: `Button`, `IconButton`, `Badge`, `StatusDot`, `Kbd`, `Tooltip`, `Skeleton`, `Meter`, icon set (stroke, 16 px grid, no emoji).
Shell: `AppShell`, `Sidebar`, `TopBar`, `CommandPalette` and `useCommandPaletteShortcut`.
Canvas: `PanelCard`, `PanelNotice`, `Inspector`, `UnitsBadge`, `FreshnessBadge`, `CompletenessBadge`, `PanelStateBadge`, `ProvenanceChip`, `DataTable`, `EvidenceGraphView`, `EmptyState`, `ErrorState`, `InvalidSpecState`, `ChartSkeleton`, `WorkspaceOnboarding`, `HonestyBanner`.
Chart: `Chart`, `buildOption`, `chartTextAlternative`, `readChartTheme`, `minMaxBucket`.
Chat: `AgentChatPanel`, `RunTimeline`, `ApprovalCard`, `AbstentionCard`, `CitationChip`, `ProposedPanels`.
Hooks: `useReducedMotion`, `useFlashOnChange`. Types mirror contracts: `ChartSpec`, `RunView`, `ApprovalView`, `TimelineEvent`, `BudgetView`, `Citation`.

## 12. Anti-AI-look rules and self-critique

Rules (checked in review; items 1 to 12 come from the `frontend-design` tell list, 13 to 16 are project-specific):

1. No purple-to-blue gradient, no gradient wash, no glow. The only gradient is the honesty hatch, which is a pattern, not decoration.
2. No emoji and no emoji-like icons in the UI. Icons are an in-repo stroke set.
3. No generic glassmorphism: no backdrop blur panels, no translucent cards.
4. No centred-everything layout: the shell, onboarding, states and chat are left-aligned; centring only for a single empty-state graphic inside an empty panel.
5. No warm cream plus terracotta; no near-black plus acid accent. Cool neutral, one restrained blue.
6. No Inter or default system stack as the identity: Geist.
7. No ALL-CAPS tracked eyebrow labels; sentence case labels.
8. No numbered markers unless the content is a sequence (the timeline is a log, not numbered).
9. No uniform radius and no identical soft shadow on every card.
10. No fade-and-slide-up on every section; no hover transforms on every card.
11. No decorative badges, pills or stats strips; a badge exists only if it encodes a state, a source or a quantity.
12. No mock marketing copy; every string is task language.
13. Never hide an honesty label to look cleaner.
14. Never show a chart for an empty result, and never draw a missing value as zero.
15. Chat is not bubbles with avatars and a typing dots animation; it is a run log with real states.
16. No unsupported claims in copy ("AI-powered", "smart").

**Self-critique log (screenshots reviewed during the build).**

1. Charts rendered blank because ECharts' brush needs the toolbox component registered: added `ToolboxComponent`.
2. Axis names collided with the legend: removed axis names; units moved into series names and panel meta.
3. Heatmap listed weekdays upside down: inverted category axis.
4. Candlestick lost its time axis: pass the time column through.
5. Every panel header carried six badges, a toolbar and a notice, leaving charts 186 px tall: READY became quiet text, units became plain text, the toolbar reveals on hover, the SYNTHETIC notice per panel became one page banner (the chip stays on each panel).
6. Run log coloured every state dot: now only the current state is coloured.
7. Panel title was indented by the invisible grip: the grip is now absolutely positioned.
8. Contrast: `--fg-subtle` and opacity-faded sub labels failed AA: darker tokens, no opacity tricks (axe, then unit tests).
9. Chat opened full screen on phones and hid the canvas: it now opens by default only on wide screens (lab) and the host must do the same.

## 13. Phase 2 integration summary

See the handoff for the exact file list. In short: `apps/web` adds `@nearesis/ui` and its CSS, replaces `globals.css`, the layout and component markup with `AppShell`, `Sidebar`, `TopBar`, `PanelCard` and `AgentChatPanel`, keeps every `data-testid` and DOM contract listed in section 4, swaps `EChart.tsx` for `Chart` fed by an adapter from `buildChartOption` inputs, and reruns C01, C04 to C18 (Playwright acceptance) before the lead accepts.

## 14. Known gaps and open items

- Budget usage: `GET /v1/runs/:id` returns no token, tool-call or cost usage, so the budget meters can only show totals. Request: add usage to the run read (kernel/API owner).
- Proposed panels: the run `result` payload shape for panels to add is not in a contract; the lab models it as `{panelId, title}`. Phase 2 must read the real `result` (A7 notes panels arrive as canvas patches).
- Sidebar data: investigations list and sources list need existing list endpoints; none is documented for investigations. Phase 2 may start with the current run only plus fixture-mode data, and the lead should decide whether a list route is wanted. No endpoint is invented here.
- `Button` and `IconButton` still use `forwardRef`.
- No manual screen-reader pass yet.
