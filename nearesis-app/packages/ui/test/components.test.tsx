import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AbstentionCard,
  AgentChatPanel,
  ApprovalCard,
  type ApprovalView,
  CommandPalette,
  EmptyState,
  FreshnessBadge,
  InvalidSpecState,
  PanelCard,
  PanelStateBadge,
  ProvenanceChip,
  RunTimeline,
  Sidebar,
  type SidebarData,
  type TimelineEvent,
  useFlashOnChange,
  useReducedMotion,
} from "../src";

const approval: ApprovalView = {
  approvalId: "9041",
  actionHash: "sha256:" + "ab".repeat(32),
  status: "pending",
  kind: "snapshot.pin",
  network: "clickhouse.read",
  costLimit: 0.2,
  requestedAt: "2026-11-10T09:30:00Z",
  decidedBy: null,
  decidedAt: null,
};

describe("PanelCard", () => {
  it("keeps the selectors apps/web acceptance tests depend on", () => {
    render(
      <PanelCard
        panelId="abc"
        kind="timeSeries"
        title="Volume"
        state="STALE"
        layout={{ x: 2, y: 1, w: 6, h: 4 }}
        meta={<FreshnessBadge freshness="late" data-testid="freshness" />}
        textAlternative="Volume. Units: USD."
      >
        <div>body</div>
      </PanelCard>,
    );
    const root = screen.getByTestId("panel-abc");
    expect(root).toHaveAttribute("data-panel-state", "STALE");
    expect(root).toHaveAttribute("data-panel-kind", "timeSeries");
    expect(within(root).getByTestId("panel-title")).toHaveTextContent("Volume");
    expect(within(root).getByTestId("panel-state")).toHaveTextContent("STALE");
    expect(within(root).getByTestId("freshness")).toHaveTextContent("late");
    expect(within(root).getByTestId("text-alternative")).toHaveTextContent("Units: USD");
    expect(root).toHaveAttribute("aria-labelledby", "t-abc");
    expect(root.style.gridColumn).toBe("3 / span 6");
    expect(root.style.gridRow).toBe("2 / span 4");
    expect(root).toHaveAttribute("tabindex", "0");
  });

  it("clamps width to the 12-column grid", () => {
    render(
      <PanelCard panelId="w" title="Wide" state="READY" layout={{ x: 0, y: 0, w: 20, h: 3 }}>
        x
      </PanelCard>,
    );
    expect(screen.getByTestId("panel-w").style.gridColumn).toBe("1 / span 12");
  });

  it("plays the patch ring once when patchKey changes, not on mount", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <PanelCard panelId="f" title="T" state="READY" layout={{ x: 0, y: 0, w: 4, h: 3 }} patchKey={1}>
        x
      </PanelCard>,
    );
    expect(screen.getByTestId("panel-f")).not.toHaveAttribute("data-flash");
    rerender(
      <PanelCard panelId="f" title="T" state="READY" layout={{ x: 0, y: 0, w: 4, h: 3 }} patchKey={2}>
        x
      </PanelCard>,
    );
    expect(screen.getByTestId("panel-f")).toHaveAttribute("data-flash", "true");
    act(() => void vi.advanceTimersByTime(1500));
    expect(screen.getByTestId("panel-f")).not.toHaveAttribute("data-flash");
    vi.useRealTimers();
  });
});

describe("honesty and state labels", () => {
  it("SYNTHETIC always renders as the dashed honesty tag, not a status chip", () => {
    render(
      <ProvenanceChip sourceLabel="SYNTHETIC" certification="experimental" data-testid="source-label" />,
    );
    const el = screen.getByTestId("source-label");
    expect(el).toHaveAttribute("data-tone", "honesty");
    expect(el).toHaveTextContent("SYNTHETIC");
    expect(el).toHaveTextContent("unattested");
  });
  it("unattested data is labelled even when the source is LIVE", () => {
    render(<ProvenanceChip sourceLabel="LIVE" certification="experimental" data-testid="p" />);
    expect(screen.getByTestId("p")).toHaveAttribute("data-tone", "honesty");
  });
  it("freshness is text, not colour alone", () => {
    render(<FreshnessBadge freshness="late" age="41m ago" data-testid="f" />);
    expect(screen.getByTestId("f")).toHaveTextContent("late");
    expect(screen.getByTestId("f")).toHaveTextContent("41m ago");
  });
  it("without an age, the badge text is exactly the freshness value (apps/web tests read textContent)", () => {
    render(<FreshnessBadge freshness="fresh" data-testid="g" />);
    expect(screen.getByTestId("g").textContent).toBe("fresh");
  });
  it("a READY panel shows quiet text; other states show a pill", () => {
    const { rerender } = render(<PanelStateBadge state="READY" data-testid="s" />);
    expect(screen.getByTestId("s")).toHaveTextContent("READY");
    expect(screen.getByTestId("s")).not.toHaveClass("nz-badge");
    rerender(<PanelStateBadge state="ERROR" data-testid="s" />);
    expect(screen.getByTestId("s")).toHaveClass("nz-badge");
  });
});

describe("states", () => {
  it("empty state names the result and does not claim zero", () => {
    render(
      <EmptyState title="No rows for this query window">
        Nothing is plotted: an empty result is not a zero series.
      </EmptyState>,
    );
    expect(screen.getByText(/not a zero series/)).toBeInTheDocument();
  });
  it("invalid spec lists issue codes and renders no chart", () => {
    render(<InvalidSpecState index={2} issues={[{ code: "UNKNOWN_PANEL_KIND", path: "panels[2].kind" }]} />);
    expect(screen.getByTestId("invalid-panel-2")).toHaveTextContent("UNKNOWN_PANEL_KIND");
    expect(screen.getByTestId("invalid-panel-2")).toHaveTextContent("was not rendered");
  });
});

describe("Sidebar", () => {
  const data: SidebarData = {
    workspaces: [{ id: "w", name: "Research" }],
    activeWorkspaceId: "w",
    investigations: [
      { id: "i1", title: "Fill rate", state: "EXECUTING" },
      { id: "i2", title: "Share", state: "BLOCKED" },
    ],
    sources: [{ id: "s1", name: "Explorer", freshness: "stale", age: "6h" }],
    reports: [],
    user: { name: "Priya Nair" },
  };
  it("marks the active item, navigates, and exposes run status as text", () => {
    const onNavigate = vi.fn();
    render(
      <Sidebar
        data={data}
        active="inv:i1"
        collapsed={false}
        onToggleCollapsed={() => undefined}
        onNavigate={onNavigate}
      />,
    );
    expect(screen.getByRole("button", { name: /Fill rate/ })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: /Share/ }));
    expect(onNavigate).toHaveBeenCalledWith("inv:i2");
    expect(screen.getAllByText("Running").length + screen.getAllByText("Blocked").length).toBeGreaterThan(0);
  });
  it("collapsed rail keeps accessible names on icon-only items", () => {
    render(
      <Sidebar
        data={data}
        active="canvas"
        collapsed
        onToggleCollapsed={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Fill rate, Running/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveAttribute("data-collapsed", "true");
  });
});

describe("CommandPalette", () => {
  it("filters and runs the selected command, then closes", () => {
    const run = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={[
          { id: "a", group: "Agent", label: "Ask a research question", run },
          { id: "b", group: "Panels", label: "Go to Settled volume", run: () => undefined },
        ]}
      />,
    );
    const input = screen.getByPlaceholderText(/Search panels/);
    fireEvent.change(input, { target: { value: "ask" } });
    expect(screen.queryByText("Go to Settled volume")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Ask a research question"));
    expect(run).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Approval and abstention", () => {
  it("decisions carry the exact action hash shown on screen", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);
    expect(screen.getByTestId("approval-hash")).toHaveTextContent(approval.actionHash);
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenCalledWith(approval, "approve");
    fireEvent.click(screen.getByTestId("approval-reject"));
    expect(onDecide).toHaveBeenLastCalledWith(approval, "reject");
  });
  it("a decided or superseded approval has no action buttons", () => {
    render(<ApprovalCard approval={{ ...approval, status: "superseded" }} onDecide={() => undefined} />);
    expect(screen.queryByTestId("approval-approve")).not.toBeInTheDocument();
    expect(screen.getByTestId("approval-card")).toHaveAttribute("data-approval-status", "superseded");
  });
  it("abstention names the metric and the reason", () => {
    render(<AbstentionCard metric="solver.volume_share" reason="identity unattested" />);
    expect(screen.getByTestId("abstention-card")).toHaveTextContent("Cannot compute solver.volume_share");
    expect(screen.getByTestId("abstention-card")).toHaveTextContent("identity unattested");
  });
});

describe("RunTimeline", () => {
  const events: TimelineEvent[] = [
    { id: "1", kind: "state", at: "t", state: "PLANNING" },
    {
      id: "2",
      kind: "agent",
      at: "t",
      role: "quant",
      objective: "Share",
      taskId: "k2",
      parentTaskId: "k1",
      status: "RUNNING",
    },
    {
      id: "3",
      kind: "query",
      at: "t",
      taskId: "k2",
      metric: "fill_rate",
      queryHash: "b41d0c7e92aa5f31",
      rows: 124,
      certification: "experimental",
    },
  ];
  it("lists rows in order with query provenance and an unattested label", () => {
    render(<RunTimeline events={events} running />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent("124 rows");
    expect(items[2]).toHaveTextContent("unattested");
  });
});

describe("AgentChatPanel", () => {
  it("submits on Enter, not on Shift+Enter, and blocks while a run is active", () => {
    const onSubmit = vi.fn();
    const props = {
      thread: [],
      runs: {},
      onSubmit,
      onCancel: () => undefined,
      onDecide: () => undefined,
      onAddToCanvas: () => undefined,
    };
    const { rerender } = render(<AgentChatPanel {...props} />);
    const box = screen.getByTestId("ask-input");
    fireEvent.change(box, { target: { value: "why did fill rate drop" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("why did fill rate drop");
    expect(screen.getByTestId("ask-input")).toHaveValue("");
    rerender(
      <AgentChatPanel
        {...props}
        thread={[{ id: "r", role: "run", runId: "r1", at: "t" }]}
        runs={{
          r1: {
            run: {
              runId: "r1",
              workspaceId: "w",
              state: "EXECUTING",
              terminal: false,
              version: 1,
              failure: null,
              result: null,
              rootTask: null,
              children: [],
              evidenceLinks: [],
            },
            events: [],
            approvals: [],
          },
        }}
      />,
    );
    fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "another" } });
    expect(screen.getByTestId("ask-submit")).toBeDisabled();
    expect(screen.getByTestId("run-status")).toHaveAttribute("data-run-state", "EXECUTING");
  });
  it("renders the run's findings with label, status, limitations and skeptic notes, and says when interpretation is unavailable", () => {
    const base = {
      runId: "r2",
      workspaceId: "w",
      state: "COMPLETE" as const,
      terminal: true,
      version: 3,
      failure: null,
      result: null,
      rootTask: null,
      children: [],
      evidenceLinks: [],
    };
    const props = {
      thread: [{ id: "r", role: "run" as const, runId: "r2", at: "t" }],
      onSubmit: () => undefined,
      onCancel: () => undefined,
      onDecide: () => undefined,
      onAddToCanvas: () => undefined,
    };
    const finding = {
      id: "f1",
      statement: "Daily NEAR transactions rose from 1000 to 1800.",
      kind: "change" as const,
      basis: "observation" as const,
      status: "mixed" as const,
      limitations: ["Panel A: 1 coverage gap(s)."],
      skepticNotes: ["The window starts at a local low."],
      panelIds: ["p1"],
      facts: [],
    };
    const { rerender } = render(
      <AgentChatPanel
        {...props}
        runs={{ r2: { run: { ...base, findings: [finding] }, events: [], approvals: [] } }}
      />,
    );
    const card = screen.getByTestId("finding");
    expect(card).toHaveAttribute("data-basis", "observation");
    expect(card).toHaveAttribute("data-status", "mixed");
    expect(card).toHaveTextContent("Daily NEAR transactions rose from 1000 to 1800.");
    expect(card).toHaveTextContent("Panel A: 1 coverage gap(s).");
    expect(card).toHaveTextContent("The window starts at a local low.");
    rerender(
      <AgentChatPanel
        {...props}
        runs={{
          r2: {
            run: { ...base, interpretation: { state: "unavailable", reason: "MODEL_TIMEOUT", findingCount: 0 } },
            events: [],
            approvals: [],
          },
        }}
      />,
    );
    expect(screen.getByTestId("findings-unavailable")).toHaveTextContent("MODEL_TIMEOUT");
  });
  it("shows the server error text unmodified in an alert", () => {
    render(
      <AgentChatPanel
        thread={[]}
        runs={{}}
        onSubmit={() => undefined}
        onCancel={() => undefined}
        onDecide={() => undefined}
        onAddToCanvas={() => undefined}
        error="422 INVALID_BODY Invalid request body."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("422 INVALID_BODY");
  });
  it("renders markup in model text as text, never as HTML", () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    render(
      <AgentChatPanel
        thread={[{ id: "r", role: "run", runId: "r1", at: "t" }]}
        runs={{
          r1: {
            run: {
              runId: "r1",
              workspaceId: "w",
              state: "COMPLETE",
              terminal: true,
              version: 1,
              failure: null,
              result: null,
              rootTask: null,
              children: [],
              evidenceLinks: [],
            },
            events: [],
            approvals: [],
            summary: evil,
            summaryDone: true,
          },
        }}
        onSubmit={() => undefined}
        onCancel={() => undefined}
        onDecide={() => undefined}
        onAddToCanvas={() => undefined}
      />,
    );
    expect(screen.getByTestId("run-summary").textContent).toBe(evil);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("motion hooks", () => {
  it("useReducedMotion follows data-motion", async () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    document.documentElement.dataset.motion = "reduced";
    await waitFor(() => expect(result.current).toBe(true));
    delete document.documentElement.dataset.motion;
    await waitFor(() => expect(result.current).toBe(false));
  });
  it("useFlashOnChange ignores the first value and resets after the window", async () => {
    const { result, rerender } = renderHook(({ k }) => useFlashOnChange(k, 50), { initialProps: { k: 1 } });
    expect(result.current).toBe(false);
    rerender({ k: 2 });
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
  });
});
