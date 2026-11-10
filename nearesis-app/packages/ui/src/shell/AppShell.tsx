import type { ReactNode } from "react";

export interface AppShellProps {
  sidebar: ReactNode;
  topbar: ReactNode;
  /** Right dock: AgentChatPanel. */
  dock: ReactNode;
  children: ReactNode;
  sidebarCollapsed: boolean;
  chatOpen: boolean;
  mobileNavOpen?: boolean;
  onDismissOverlays?: () => void;
}

/** Three-column shell: sidebar | (topbar + content) | agent dock. Overlays on narrow screens. */
export function AppShell({
  sidebar,
  topbar,
  dock,
  children,
  sidebarCollapsed,
  chatOpen,
  mobileNavOpen,
  onDismissOverlays,
}: AppShellProps) {
  return (
    <div
      className="nz-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
      data-chat={chatOpen ? "open" : "closed"}
      data-mobile-nav={mobileNavOpen ? "open" : "closed"}
    >
      {sidebar}
      <div className="nz-main">
        {topbar}
        <main className="nz-content" aria-label="Research canvas" id="main">
          {children}
        </main>
      </div>
      <aside
        className="nz-dock"
        data-open={chatOpen ? "true" : "false"}
        aria-label="Agent"
        aria-hidden={chatOpen ? undefined : true}
        inert={chatOpen ? undefined : true}
      >
        <div className="nz-dock-inner">{dock}</div>
      </aside>
      <div className="nz-scrim" onClick={onDismissOverlays} aria-hidden="true" />
    </div>
  );
}
