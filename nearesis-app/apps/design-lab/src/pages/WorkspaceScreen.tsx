import {
  AgentChatPanel,
  AppShell,
  Button,
  Chart,
  ChartSkeleton,
  type ChartSpec,
  CommandPalette,
  CompletenessBadge,
  DataTable,
  EmptyState,
  ErrorState,
  EvidenceGraphView,
  FreshnessBadge,
  HonestyBanner,
  IconButton,
  IconCanvas,
  IconInvestigation,
  IconRedo,
  IconSearch,
  IconUndo,
  InvalidSpecState,
  Inspector,
  PanelCard,
  PanelNotice,
  type PaletteCommand,
  ProvenanceChip,
  Sidebar,
  type SidebarData,
  TopBar,
  UnitsBadge,
  WorkspaceOnboarding,
  useCommandPaletteShortcut,
  useFlashOnChange,
  type PanelState,
  type RunState,
} from "@nearesis/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  candlestickSpec,
  chainBarSpec,
  fillLatencySpec,
  heatmapSpec,
  tableRows,
  volumeSpec,
} from "../fixtures/data";
import type { SeedName } from "../fixtures/run";
import { useMockRun } from "../useMockRun";

const SIDEBAR: SidebarData = {
  workspaces: [{ id: "w1", name: "NEAR Intents research" }],
  activeWorkspaceId: "w1",
  investigations: [
    { id: "i1", title: "Solana fill rate after 24 Oct", state: "EXECUTING" },
    { id: "i2", title: "Solver concentration", state: "APPROVAL_NEEDED" },
    { id: "i3", title: "Net volume by chain pair", state: "COMPLETE" },
    { id: "i4", title: "Stablecoin route share", state: "PARTIAL" },
    { id: "i5", title: "Bitcoin inbound anomalies", state: "BLOCKED" },
  ],
  sources: [
    { id: "s1", name: "NEAR Intents explorer", freshness: "fresh", age: "2m" },
    { id: "s2", name: "Solver quotes", freshness: "late", age: "41m" },
    { id: "s3", name: "Bridge ledger", freshness: "stale", age: "6h" },
  ],
  reports: [
    { id: "r1", title: "October settlement review" },
    { id: "r2", title: "Solver health, weekly" },
  ],
  user: { name: "Priya Nair", email: "priya@example.org" },
};

const NOTE =
  "Volume dipped on 25 to 28 October because the explorer source was unavailable. The shaded band is missing data, not zero volume.";
const FIXTURE_PROV = { sourceLabel: "SYNTHETIC" as const, certification: "experimental" as const };

interface PanelDef {
  id: string;
  title: string;
  layout: { x: number; y: number; w: number; h: number };
  state: PanelState;
  kind: "chart" | "table" | "note" | "graph";
  spec?: ChartSpec;
  units: Array<[string, string]>;
  freshness: "fresh" | "late" | "partial" | "unavailable";
  completeness: "complete" | "partial" | "unavailable";
  watermark: string;
}

function defs(variant: "baseline" | "states"): PanelDef[] {
  const wm = "2026-11-09T23:59Z";
  const base: PanelDef[] = [
    {
      id: "p1",
      title: "Settled volume",
      layout: { x: 0, y: 0, w: 8, h: 7 },
      state: "READY",
      kind: "chart",
      spec: volumeSpec(),
      units: [["settled_volume", "USD m"]],
      freshness: "fresh",
      completeness: "partial",
      watermark: wm,
    },
    {
      id: "p2",
      title: "Intents by origin chain",
      layout: { x: 8, y: 0, w: 4, h: 7 },
      state: "READY",
      kind: "chart",
      spec: chainBarSpec(),
      units: [["count", "intents"]],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
    {
      id: "p3",
      title: "Fill rate and latency",
      layout: { x: 0, y: 7, w: 6, h: 7 },
      state: "READY",
      kind: "chart",
      spec: fillLatencySpec(),
      units: [
        ["fill_rate", "%"],
        ["p95_latency", "ms"],
      ],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
    {
      id: "p4",
      title: "Hourly volume",
      layout: { x: 6, y: 7, w: 6, h: 7 },
      state: "READY",
      kind: "chart",
      spec: heatmapSpec(),
      units: [["volume", "USD k"]],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
    {
      id: "p5",
      title: "NEAR/USDC",
      layout: { x: 0, y: 14, w: 6, h: 7 },
      state: "READY",
      kind: "chart",
      spec: candlestickSpec(),
      units: [["close", "USDC"]],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
    {
      id: "p6",
      title: "Pair breakdown",
      layout: { x: 6, y: 14, w: 6, h: 7 },
      state: "READY",
      kind: "table",
      units: [["volume", "USD"]],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
    {
      id: "p7",
      title: "Evidence graph",
      layout: { x: 0, y: 21, w: 8, h: 8 },
      state: "READY",
      kind: "graph",
      units: [],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
    {
      id: "p8",
      title: "Reading note",
      layout: { x: 8, y: 21, w: 4, h: 8 },
      state: "READY",
      kind: "note",
      units: [],
      freshness: "fresh",
      completeness: "complete",
      watermark: wm,
    },
  ];
  if (variant === "baseline") return base;
  return [
    { ...base[0]!, state: "STALE", freshness: "late", layout: { x: 0, y: 0, w: 6, h: 7 } },
    { ...base[1]!, state: "ERROR", layout: { x: 6, y: 0, w: 6, h: 7 } },
    { ...base[2]!, state: "QUERYING", layout: { x: 0, y: 7, w: 6, h: 7 } },
    { ...base[3]!, state: "REFRESHING", layout: { x: 6, y: 7, w: 6, h: 7 } },
  ];
}

const GRAPH_NODES = [
  { id: "g1", type: "source", label: "NEAR Intents explorer" },
  { id: "g2", type: "query", label: "intents.settled_volume by day" },
  { id: "g3", type: "query", label: "solver.fill_rate by chain" },
  { id: "g4", type: "observation", label: "Fill rate fell 6.5 pts on Solana" },
  { id: "g5", type: "hypothesis", label: "Outage drove the drop" },
  { id: "g6", type: "marker", label: "24 Oct outage window" },
  { id: "g7", type: "agent", label: "quant" },
];
const GRAPH_EDGES = [
  { id: "ge1", source: "g1", target: "g2", relation: "derived_from" },
  { id: "ge2", source: "g1", target: "g3", relation: "derived_from" },
  { id: "ge3", source: "g3", target: "g4", relation: "supports" },
  { id: "ge4", source: "g4", target: "g5", relation: "supports" },
  { id: "ge5", source: "g6", target: "g5", relation: "references" },
  { id: "ge6", source: "g7", target: "g4", relation: "reproduces" },
];

function PanelBody({ d, inspect }: { d: PanelDef; inspect: boolean }) {
  if (d.state === "QUERYING" || d.state === "VALIDATING") return <ChartSkeleton />;
  if (d.state === "ERROR")
    return (
      <ErrorState code="QUERY_UNRESOLVED" message="query result not available" onRetry={() => undefined} />
    );
  if (d.kind === "note")
    return <div style={{ padding: "4px 12px", maxWidth: "58ch", lineHeight: 1.6 }}>{NOTE}</div>;
  if (d.kind === "table") {
    const t = tableRows();
    return <DataTable columns={t.columns} rows={t.rows} />;
  }
  if (d.kind === "graph") return <EvidenceGraphView nodes={GRAPH_NODES} edges={GRAPH_EDGES} />;
  void inspect;
  return d.spec ? <Chart spec={d.spec} testId={`chart-${d.id}`} /> : null;
}

function Panel({ d, selected, onSelect }: { d: PanelDef; selected: boolean; onSelect: () => void }) {
  const [inspect, setInspect] = useState(false);
  return (
    <PanelCard
      panelId={d.id}
      title={d.title}
      state={d.state}
      layout={d.layout}
      selected={selected}
      onClick={onSelect}
      patchKey={d.state}
      onGripPointerDown={() => undefined}
      gripLabel={`Move panel ${d.title}`}
      meta={
        <>
          <FreshnessBadge
            freshness={d.freshness}
            age={d.freshness === "late" ? "41m" : undefined}
            data-testid="freshness"
          />
          <CompletenessBadge completeness={d.completeness} data-testid="completeness" />
          <ProvenanceChip {...FIXTURE_PROV} data-testid="source-label" />
          <UnitsBadge units={d.units} data-testid="units" />
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={inspect}
            onClick={(e) => {
              e.stopPropagation();
              setInspect((v) => !v);
            }}
            data-testid="provenance-toggle"
          >
            Provenance
          </Button>
        </>
      }
      toolbar={
        d.kind === "chart" && d.spec?.x.type === "time" ? (
          <>
            <Button size="sm">Select range</Button>
            <Button size="sm">Add threshold</Button>
          </>
        ) : null
      }
      notices={
        <>
          {d.state === "STALE" ? (
            <PanelNotice tone="warn" data-testid="stale-notice">
              Source is late: showing last good data from {d.watermark}.
            </PanelNotice>
          ) : null}
          {d.state === "ERROR" ? (
            <PanelNotice tone="bad" data-testid="error-notice">
              QUERY_UNRESOLVED: query result not available.
            </PanelNotice>
          ) : null}
        </>
      }
      footer={
        <>
          <span data-testid="watermark">watermark {d.watermark}</span>
          {d.spec?.gaps?.length ? (
            <span data-testid="gap-label">gaps shaded, not interpolated: {d.spec.gaps.length}</span>
          ) : null}
          {d.kind === "chart" ? (
            <span data-testid="downsampling">
              downsampling: none ({d.spec?.rows.length}/{d.spec?.rows.length} pts)
            </span>
          ) : null}
        </>
      }
      inspector={
        inspect ? (
          <Inspector
            data={{
              queryHash: "b41d0c7e92aa5f31",
              semanticVersion: "1.0.0",
              certification: "experimental",
              sourceLabel: "SYNTHETIC",
            }}
            data-testid="inspector"
          />
        ) : null
      }
    >
      <PanelBody d={d} inspect={inspect} />
    </PanelCard>
  );
}

export function WorkspaceScreen({
  variant,
  seed = "empty",
}: {
  variant: "baseline" | "states" | "empty";
  seed?: SeedName;
}) {
  const q = new URLSearchParams(location.search);
  const [collapsed, setCollapsed] = useState(q.get("sidebar") === "collapsed");
  const [chatOpen, setChatOpen] = useState(
    q.get("chat") ? q.get("chat") === "open" : innerWidth > 900 || seed !== "empty",
  );
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(q.get("palette") === "open");
  const [active, setActive] = useState("canvas");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const run = useMockRun(seed, Number(q.get("speed") ?? 1));
  const [rev, setRev] = useState(0);
  const flash = useFlashOnChange(rev);
  void flash;

  useCommandPaletteShortcut(setPalette);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const panels = useMemo(
    () => (variant === "empty" ? [] : defs(variant === "states" ? "states" : "baseline")),
    [variant],
  );
  const commands: PaletteCommand[] = [
    {
      id: "ask",
      group: "Agent",
      label: "Ask a research question",
      icon: <IconSearch />,
      shortcut: "⌘J",
      run: () => setChatOpen(true),
    },
    {
      id: "undo",
      group: "Canvas",
      label: "Undo last canvas change",
      icon: <IconUndo />,
      shortcut: "⌘Z",
      run: () => setRev((r) => r + 1),
    },
    {
      id: "redo",
      group: "Canvas",
      label: "Redo",
      icon: <IconRedo />,
      shortcut: "⇧⌘Z",
      run: () => setRev((r) => r + 1),
    },
    ...panels.map((p) => ({
      id: `go-${p.id}`,
      group: "Panels",
      label: `Go to ${p.title}`,
      icon: <IconCanvas />,
      run: () => setSelected(p.id),
    })),
    ...SIDEBAR.investigations.map((i) => ({
      id: `inv-${i.id}`,
      group: "Investigations",
      label: i.title,
      icon: <IconInvestigation />,
      hint: i.state.toLowerCase().replace("_", " "),
      run: () => setActive(`inv:${i.id}`),
    })),
  ];

  const runModel = Object.values(run.runs)[0];
  const runState: RunState | undefined = runModel?.run.state;
  const busy = runState !== undefined && !runModel?.run.terminal;
  const content: ReactNode =
    variant === "empty" ? (
      <WorkspaceOnboarding onAsk={() => setChatOpen(true)} />
    ) : (
      <>
        <div className="nz-ws-header">
          <h1>Settlement review</h1>
          <span className="nz-sb-meta nz-tabular" data-testid="document-revision">
            doc rev 14
          </span>
          <span className="nz-sb-meta nz-tabular" data-testid="data-revision">
            data rev 3
          </span>
          <span className="nz-grow" />
          <IconButton label="Undo" shortcut="⌘Z" data-testid="undo" onClick={() => setRev((r) => r + 1)}>
            <IconUndo />
          </IconButton>
          <IconButton label="Redo" shortcut="⇧⌘Z" data-testid="redo" disabled>
            <IconRedo />
          </IconButton>
        </div>
        <HonestyBanner data-testid="mode-badge">
          Fixture mode: every number here is SYNTHETIC and unattested. Nothing is production data.
        </HonestyBanner>
        <div className="nz-canvas" aria-label="Panels">
          {panels.map((p) => (
            <Panel key={p.id} d={p} selected={selected === p.id} onSelect={() => setSelected(p.id)} />
          ))}
          {variant === "states" ? (
            <>
              <div
                className="nz-panel"
                style={{ gridColumn: "1 / span 6", gridRow: "15 / span 5" }}
                data-testid="invalid-wrap"
              >
                <InvalidSpecState
                  index={4}
                  issues={[
                    { code: "UNKNOWN_PANEL_KIND", path: "panels[4].kind" },
                    { code: "MISSING_UNITS", path: "panels[4].dataBinding.units" },
                  ]}
                />
              </div>
              <div className="nz-panel" style={{ gridColumn: "7 / span 6", gridRow: "15 / span 5" }}>
                <EmptyState title="No rows for this query window" center>
                  Nothing is plotted: an empty result is not a zero series. Coverage: partial; gaps: 0; source
                  watermark 2026-11-09T23:59Z.
                </EmptyState>
              </div>
            </>
          ) : null}
        </div>
      </>
    );

  return (
    <>
      <AppShell
        sidebarCollapsed={collapsed}
        chatOpen={chatOpen}
        mobileNavOpen={mobileNav}
        onDismissOverlays={() => {
          setMobileNav(false);
          setChatOpen(false);
        }}
        sidebar={
          <Sidebar
            data={SIDEBAR}
            active={active}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
            onNavigate={(k) => {
              setActive(k);
              setMobileNav(false);
            }}
          />
        }
        topbar={
          <TopBar
            crumbs={[{ label: "NEAR Intents research" }, { label: "Canvas" }, { label: "Settlement review" }]}
            connection={variant === "states" ? "reconnecting" : "live"}
            run={
              busy
                ? {
                    label: "Run budget",
                    used: runModel?.budget?.tokens.used ?? 0,
                    total: 60000,
                    unit: "tokens",
                  }
                : null
            }
            onOpenPalette={() => setPalette(true)}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((o) => !o)}
            onOpenNav={() => setMobileNav(true)}
            theme={theme}
            onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          />
        }
        dock={
          <AgentChatPanel
            thread={run.thread}
            runs={run.runs}
            onSubmit={run.submit}
            onCancel={run.cancel}
            onDecide={run.decide}
            onAddToCanvas={run.addToCanvas}
            onClose={() => setChatOpen(false)}
            budgetNote="Budget per question: 60k tokens, 16 tool calls, $1.00"
          />
        }
      >
        {content}
      </AppShell>
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} />
    </>
  );
}
