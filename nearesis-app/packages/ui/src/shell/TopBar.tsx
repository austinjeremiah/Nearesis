import type { ReactNode } from "react";
import { IconChat, IconMoon, IconSearch, IconSidebar, IconSun } from "../icons";
import { IconButton, Kbd, Meter, StatusDot, type Tone } from "../primitives";
import type { ConnectionState } from "../types";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

const CONN: Record<ConnectionState, { tone: Tone; label: string }> = {
  live: { tone: "ok", label: "Live" },
  reconnecting: { tone: "warn", label: "Reconnecting" },
  offline: { tone: "bad", label: "Offline" },
  reload_required: { tone: "warn", label: "Reload required" },
};

export interface RunIndicator {
  label: string;
  used: number;
  total: number;
  unit?: string;
}

export interface TopBarProps {
  crumbs: Crumb[];
  connection: ConnectionState;
  /** Budget/run indicator. Omit when no run is active. */
  run?: RunIndicator | null;
  onOpenPalette: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenNav?: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Undo/redo and other workspace actions. */
  actions?: ReactNode;
}

export function TopBar({
  crumbs,
  connection,
  run,
  onOpenPalette,
  chatOpen,
  onToggleChat,
  onOpenNav,
  theme,
  onToggleTheme,
  actions,
}: TopBarProps) {
  const c = CONN[connection];
  return (
    <header className="nz-topbar">
      {onOpenNav ? (
        <IconButton label="Open navigation" onClick={onOpenNav} className="nz-mobile-only">
          <IconSidebar />
        </IconButton>
      ) : null}
      <nav className="nz-crumbs" aria-label="Breadcrumb">
        <ol>
          {crumbs.map((cr, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${cr.label}-${i}`}>
                {last ? (
                  <span aria-current="page">{cr.label}</span>
                ) : (
                  <button
                    type="button"
                    className="nz-btn"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={cr.onClick}
                  >
                    {cr.label}
                  </button>
                )}
                {last ? null : (
                  <span className="nz-crumb-sep" aria-hidden="true">
                    /
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <button
        type="button"
        className="nz-search-trigger"
        onClick={onOpenPalette}
        aria-keyshortcuts="Meta+K Control+K"
      >
        <IconSearch />
        <span className="nz-grow">Search or run a command</span>
        <Kbd>⌘K</Kbd>
      </button>
      {actions}
      {run ? (
        <div className="nz-budget nz-hide-narrow" data-testid="budget-indicator">
          <span>{run.label}</span>
          <Meter value={run.used} max={run.total} label={`${run.label} used`} />
          <span className="nz-tabular">
            {run.used.toLocaleString("en-US")}/{run.total.toLocaleString("en-US")}
            {run.unit ? ` ${run.unit}` : ""}
          </span>
        </div>
      ) : null}
      <span
        className="nz-conn nz-hide-narrow"
        role="status"
        data-testid="connection-state"
        data-conn={connection}
      >
        <StatusDot tone={c.tone} pulse={connection === "reconnecting"} />
        {c.label}
      </span>
      <IconButton
        label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? <IconSun /> : <IconMoon />}
      </IconButton>
      <IconButton
        label={chatOpen ? "Hide agent panel" : "Show agent panel"}
        shortcut="⌘J"
        onClick={onToggleChat}
        aria-pressed={chatOpen}
      >
        <IconChat />
      </IconButton>
    </header>
  );
}
