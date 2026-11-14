# Getting started

## 1. Sign in and open a workspace

In development builds, use **Sign in (dev)** in the sidebar footer. Production uses the configured identity provider.

A workspace holds one investigation: its canvas, evidence, history and monitoring. The switcher at the top of the sidebar lists your workspaces. Choosing one opens it. Workspaces belonging to other organisations are never listed or reachable; their URLs return "not found".

## 2. The canvas

The canvas shows analytic panels: time series, bars, tables and notes. Every panel shows:

- its **units**, **freshness** (fresh, late, partial or unavailable) and **completeness**;
- a **provenance** button. It opens the exact certified query, semantic version, snapshot and result hash behind the panel.

Interactions:

- **Move or resize** a panel by dragging its grip, or focus the panel and press Alt+Arrow (Alt+Shift+Arrow resizes).
- **Select a time range** with "select range" and a drag, or focus the chart and use the arrow keys, Shift+arrows and Enter. The selection stores the query, interval, series, units and watermark. It never starts an agent by itself.
- **Mark** a selection with "mark selection", or add a threshold marker.
- **Undo and redo** with the toolbar buttons or Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z.

Edits are saved by the server, and two tabs editing at once get a conflict notice instead of a silent overwrite.

The **Fixture (SYNTHETIC) / Live (LIVE)** switch in the top bar chooses the data layer.

## 3. Monitoring

**Monitoring** in the sidebar lists markers, monitor rules, triggers, lenses and notifications. A marker's linked evidence opens in the evidence graph.

## 4. Research pages

The **Research** group in the sidebar opens:

- **Investment thesis.** The research question, observed series with coverage, and the research engine's published results.
- **Evidence graph.** Hypotheses, claims, results, queries and sources, with their relations.
- **Time machine.** Snapshots, comparisons, branches, merges and event-log reconstruction.
- **Shared layout.** Panel positions and a shared note, edited together in real time.
- **Research capsules.** The reproducible package behind a result and its verification status.

See [Reading the research pages](RESEARCH_PAGES.md).

## 5. Settings and reports

**Settings** shows the session, theme and data source. **Reports** opens the report for a finished investigation.
