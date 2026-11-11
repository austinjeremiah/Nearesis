import { type ReactNode, useEffect, useRef, useState } from "react";
import { FreshnessBadge } from "../canvas/badges";
import {
  IconCanvas,
  IconChevronDown,
  IconInvestigation,
  IconReport,
  IconSettings,
  IconSidebar,
  IconSource,
} from "../icons";
import { IconButton, StatusDot, Tooltip, type Tone } from "../primitives";
import type { Freshness, RunState } from "../types";

export interface SidebarInvestigation {
  id: string;
  title: string;
  state: RunState;
  updated?: string;
}
export interface SidebarSource {
  id: string;
  name: string;
  freshness: Freshness;
  age?: string;
}
export interface SidebarData {
  workspaces: Array<{ id: string; name: string }>;
  activeWorkspaceId: string;
  investigations: SidebarInvestigation[];
  sources: SidebarSource[];
  reports: Array<{ id: string; title: string }>;
  user: { name: string; email?: string };
}

const RUN_TONE: Record<RunState, { tone: Tone; pulse: boolean; label: string }> = {
  REQUESTED: { tone: "info", pulse: true, label: "Requested" },
  PLANNING: { tone: "info", pulse: true, label: "Planning" },
  APPROVAL_NEEDED: { tone: "warn", pulse: true, label: "Needs approval" },
  EXECUTING: { tone: "info", pulse: true, label: "Running" },
  EVIDENCE_REVIEW: { tone: "info", pulse: true, label: "Reviewing evidence" },
  CANVAS_PATCH_REVIEW: { tone: "info", pulse: true, label: "Preparing panels" },
  COMPLETE: { tone: "ok", pulse: false, label: "Complete" },
  PARTIAL: { tone: "warn", pulse: false, label: "Partial" },
  BLOCKED: { tone: "bad", pulse: false, label: "Blocked" },
  CANCELLED: { tone: "neutral", pulse: false, label: "Cancelled" },
};
export const runStatusLabel = (s: RunState) => RUN_TONE[s].label;

const FRESH_DOT: Record<Freshness, Tone> = {
  fresh: "ok",
  late: "warn",
  partial: "warn",
  stale: "warn",
  unavailable: "bad",
};

export interface SidebarProps {
  data: SidebarData;
  /** "canvas" | "settings" | "inv:<id>" | "src:<id>" | "rep:<id>" */
  active: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate: (key: string) => void;
  /** Called with the chosen workspace id from the switcher menu. The current workspace is a no-op. */
  onSwitchWorkspace?: (workspaceId: string) => void;
  /** Rendered in the footer next to the user (theme switch and so on). */
  footerExtra?: ReactNode;
}

function Item({
  icon,
  children,
  current,
  onClick,
  label,
  collapsed,
  meta,
}: {
  icon: ReactNode;
  children: ReactNode;
  current?: boolean;
  onClick: () => void;
  label: string;
  collapsed: boolean;
  meta?: ReactNode;
}) {
  const btn = (
    <button
      type="button"
      className="nz-sb-item"
      aria-current={current ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="nz-grow nz-hide-collapsed">{children}</span>
      {meta ? <span className="nz-hide-collapsed">{meta}</span> : null}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

/**
 * Collapsible left navigation: workspace switcher, canvas, investigations with live run status, sources with freshness,
 * reports, settings and the user. Collapsed = 52px icon rail with tooltips; below 760px it becomes a drawer.
 */
export function Sidebar({
  data,
  active,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  onSwitchWorkspace,
  footerExtra,
}: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!headRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  const ws = data.workspaces.find((w) => w.id === data.activeWorkspaceId) ?? data.workspaces[0];
  const initials = data.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <nav className="nz-sidebar" data-collapsed={collapsed ? "true" : "false"} aria-label="Primary">
      <div className="nz-sb-head" ref={headRef}>
        <button
          type="button"
          className="nz-ws-switch"
          data-testid="workspace-switch"
          aria-label={collapsed ? `${ws?.name ?? "No workspace"}, switch workspace` : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Switch workspace"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="nz-ws-mark" aria-hidden="true">
            {(ws?.name ?? "N").slice(0, 1).toUpperCase()}
          </span>
          <span
            className="nz-grow nz-hide-collapsed"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {ws?.name}
          </span>
          <IconChevronDown className="nz-icon nz-hide-collapsed" />
        </button>
        {menuOpen && (
          <div className="nz-ws-menu" role="menu" aria-label="Workspaces" data-testid="workspace-menu">
            {data.workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                role="menuitemradio"
                aria-checked={w.id === data.activeWorkspaceId}
                className="nz-ws-menu-item"
                data-testid={`workspace-option-${w.id}`}
                onClick={() => {
                  setMenuOpen(false);
                  if (w.id !== data.activeWorkspaceId) onSwitchWorkspace?.(w.id);
                }}
              >
                <span className="nz-ws-mark" aria-hidden="true">
                  {w.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="nz-grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {w.name}
                </span>
              </button>
            ))}
            {data.workspaces.length <= 1 && (
              <div className="nz-sb-meta" style={{ padding: "var(--space-2)" }}>
                No other workspaces for this account.
              </div>
            )}
          </div>
        )}
        <IconButton
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          shortcut="["
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
        >
          <IconSidebar />
        </IconButton>
      </div>
      <div className="nz-sb-scroll">
        <div className="nz-sb-group">
          <Item
            icon={<IconCanvas />}
            label="Canvas"
            collapsed={collapsed}
            current={active === "canvas"}
            onClick={() => onNavigate("canvas")}
          >
            Canvas
          </Item>
        </div>
        <div className="nz-sb-group">
          <div className="nz-sb-label nz-hide-collapsed">Investigations</div>
          {data.investigations.map((i) => {
            const s = RUN_TONE[i.state];
            return (
              <Item
                key={i.id}
                icon={<IconInvestigation />}
                label={`${i.title}, ${s.label}`}
                collapsed={collapsed}
                current={active === `inv:${i.id}`}
                onClick={() => onNavigate(`inv:${i.id}`)}
                meta={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={s.label}>
                    <StatusDot tone={s.tone} pulse={s.pulse} />
                    <span className="nz-sb-meta nz-sr-only">{s.label}</span>
                  </span>
                }
              >
                {i.title}
              </Item>
            );
          })}
        </div>
        <div className="nz-sb-group">
          <div className="nz-sb-label nz-hide-collapsed">Sources</div>
          {data.sources.map((s) => (
            <Item
              key={s.id}
              icon={<IconSource />}
              label={`${s.name}, ${s.freshness}`}
              collapsed={collapsed}
              current={active === `src:${s.id}`}
              onClick={() => onNavigate(`src:${s.id}`)}
              meta={
                s.age ? (
                  <span className="nz-sb-meta nz-tabular">{s.age}</span>
                ) : (
                  <FreshnessBadge freshness={s.freshness} />
                )
              }
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <StatusDot tone={FRESH_DOT[s.freshness]} />
                {s.name}
              </span>
            </Item>
          ))}
        </div>
        <div className="nz-sb-group">
          <div className="nz-sb-label nz-hide-collapsed">Reports</div>
          {data.reports.map((r) => (
            <Item
              key={r.id}
              icon={<IconReport />}
              label={r.title}
              collapsed={collapsed}
              current={active === `rep:${r.id}`}
              onClick={() => onNavigate(`rep:${r.id}`)}
            >
              {r.title}
            </Item>
          ))}
        </div>
        <div className="nz-sb-group">
          <Item
            icon={<IconSettings />}
            label="Settings"
            collapsed={collapsed}
            current={active === "settings"}
            onClick={() => onNavigate("settings")}
          >
            Settings
          </Item>
        </div>
      </div>
      <div className="nz-sb-foot">
        <span className="nz-avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="nz-hide-collapsed nz-grow" style={{ minWidth: 0 }}>
          <div
            style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {data.user.name}
          </div>
          {data.user.email ? (
            <div className="nz-sb-meta" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {data.user.email}
            </div>
          ) : null}
        </div>
        <span className="nz-hide-collapsed">{footerExtra}</span>
      </div>
    </nav>
  );
}
