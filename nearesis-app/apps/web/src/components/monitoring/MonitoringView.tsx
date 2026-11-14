"use client";
import { Button, PanelNotice } from "@nearesis/ui";
import { type KeyboardEvent, useCallback, useEffect, useState } from "react";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import { type LensApplication, LensesTab } from "./LensesTab.tsx";
import { type PanelRef, MarkersTab } from "./MarkersTab.tsx";
import { DelegationTab } from "./DelegationTab.tsx";
import { EvaluationsTab } from "./EvaluationsTab.tsx";
import { NotificationsTab } from "./NotificationsTab.tsx";
import { type SourceRef, RulesTab } from "./RulesTab.tsx";
import { fmtTime } from "./shared.tsx";
import { TriggersTab } from "./TriggersTab.tsx";

export type MonitorTab =
  "markers" | "rules" | "triggers" | "evaluations" | "lenses" | "notifications" | "delegation";
const TABS: Array<{ id: MonitorTab; label: string }> = [
  { id: "markers", label: "Markers" },
  { id: "rules", label: "Rules" },
  { id: "triggers", label: "Trigger history" },
  { id: "evaluations", label: "Evaluations" },
  { id: "lenses", label: "Lenses" },
  { id: "notifications", label: "Notifications" },
  { id: "delegation", label: "Delegation" },
];

export interface MonitorUi {
  tab: MonitorTab;
  markerId: string | null;
  ruleId: string | null;
  /** Lens applied to the canvas; re-resolved against the backend after reload. */
  lensId: string | null;
}
const DEFAULT_UI: MonitorUi = { tab: "markers", markerId: null, ruleId: null, lensId: null };

/** Per-workspace view state kept in this browser (selection, tab). Backend data is never stored here. */
export function useMonitorUi(workspaceId: string): [MonitorUi, (patch: Partial<MonitorUi>) => void] {
  const key = `nz-mon:${workspaceId}`;
  const [ui, setUi] = useState<MonitorUi>(DEFAULT_UI);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const p = JSON.parse(raw) as Partial<MonitorUi>;
        setUi({
          tab: TABS.some((t) => t.id === p.tab) ? (p.tab as MonitorTab) : "markers",
          markerId: typeof p.markerId === "string" ? p.markerId : null,
          ruleId: typeof p.ruleId === "string" ? p.ruleId : null,
          lensId: typeof p.lensId === "string" ? p.lensId : null,
        });
      }
    } catch {
      /* storage unavailable: defaults */
    }
  }, [key]);
  const update = useCallback(
    (patch: Partial<MonitorUi>) =>
      setUi((cur) => {
        const next = { ...cur, ...patch };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* per-tab only */
        }
        return next;
      }),
    [key],
  );
  return [ui, update];
}

export function MonitoringView(p: {
  store: MonitoringStore;
  ui: MonitorUi;
  setUi: (patch: Partial<MonitorUi>) => void;
  panels: PanelRef[];
  sources: SourceRef[];
  metrics: string[];
  selectionInterval: { start: string; end: string } | null;
  lens: LensApplication | null;
  onApplyLens: (lensId: string | null) => Promise<void>;
  onFocusPanel: (panelId: string) => void;
  onOpenEvidence: (evidenceId: string) => void;
  onNotice: (m: string) => void;
  onBack: () => void;
}) {
  const { store, ui } = p;
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === ui.tab);
    const n =
      e.key === "ArrowRight"
        ? i + 1
        : e.key === "ArrowLeft"
          ? i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? TABS.length - 1
              : -1;
    if (n < 0) return;
    e.preventDefault();
    const t = TABS[(n + TABS.length) % TABS.length]!;
    p.setUi({ tab: t.id });
    document.getElementById(`mon-tab-${t.id}`)?.focus();
  };
  const staleSources = p.sources.filter((s) => s.freshness !== "fresh");
  return (
    <article className="nz-page nz-page-wide" data-testid="monitoring-view" aria-labelledby="mon-title">
      <header>
        <h1 id="mon-title">Monitoring</h1>
        <p className="nz-sb-meta" data-testid="monitoring-sync">
          {store.status === "loading" && "Loading from the backend…"}
          {store.status === "ready" && `Synced ${fmtTime(store.lastLoadedAt)}`}
          {store.status === "degraded" &&
            `Backend unavailable (${store.error?.status || "network"}); showing last data from ${fmtTime(store.lastLoadedAt)}`}
          {store.status === "off" && "Monitoring needs the kernel backend."}
        </p>
      </header>
      {store.api?.kind === "test-adapter" && (
        <PanelNotice tone="honesty" role="status" data-testid="test-adapter-banner">
          TEST ADAPTER: in-memory data for UI testing. This is not the monitoring backend and nothing here is
          persisted.
        </PanelNotice>
      )}
      {store.status === "degraded" && (
        <PanelNotice tone="bad" role="alert" data-testid="monitoring-degraded">
          Could not reach the monitoring API ({store.error?.message}). The lists below are the last data
          received and may be out of date.
        </PanelNotice>
      )}
      {staleSources.length > 0 && (
        <PanelNotice tone="warn" role="status" data-testid="sources-degraded">
          Degraded sources: {staleSources.map((s) => `${s.id} (${s.freshness})`).join(", ")}. Rules on these
          sources may report no data instead of firing.
        </PanelNotice>
      )}
      {store.status === "off" ? (
        <div className="nz-page-actions">
          <Button onClick={p.onBack}>Back to canvas</Button>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Monitoring sections" className="nz-tabs" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                id={`mon-tab-${t.id}`}
                type="button"
                role="tab"
                className="nz-tab"
                data-testid={`tab-${t.id}`}
                aria-selected={ui.tab === t.id}
                aria-controls="mon-panel"
                tabIndex={ui.tab === t.id ? 0 : -1}
                onClick={() => p.setUi({ tab: t.id })}
              >
                {t.label}
                {t.id === "notifications" && store.unread > 0 && (
                  <span className="nz-count" data-testid="unread-count">
                    {store.unread}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="mon-panel" aria-labelledby={`mon-tab-${ui.tab}`}>
            {ui.tab === "markers" && (
              <MarkersTab
                store={store}
                panels={p.panels}
                selectedId={ui.markerId}
                onSelect={(id) => p.setUi({ markerId: id })}
                onFocusPanel={p.onFocusPanel}
                onOpenEvidence={p.onOpenEvidence}
                onNotice={p.onNotice}
              />
            )}
            {ui.tab === "rules" && (
              <RulesTab
                store={store}
                sources={p.sources}
                metrics={p.metrics}
                selectedId={ui.ruleId}
                onSelect={(id) => p.setUi({ ruleId: id })}
                onNotice={p.onNotice}
              />
            )}
            {ui.tab === "triggers" && <TriggersTab store={store} />}
            {ui.tab === "evaluations" && <EvaluationsTab store={store} />}
            {ui.tab === "delegation" && <DelegationTab store={store} />}
            {ui.tab === "lenses" && (
              <LensesTab
                store={store}
                panels={p.panels}
                selectionInterval={p.selectionInterval}
                active={p.lens}
                onApply={p.onApplyLens}
                onNotice={p.onNotice}
              />
            )}
            {ui.tab === "notifications" && (
              <NotificationsTab
                store={store}
                onNotice={p.onNotice}
                onOpenMarker={(id) => p.setUi({ tab: "markers", markerId: id })}
              />
            )}
          </div>
          <div className="nz-page-actions">
            <Button onClick={p.onBack} data-testid="back-to-canvas">
              Back to canvas
            </Button>
          </div>
        </>
      )}
    </article>
  );
}
