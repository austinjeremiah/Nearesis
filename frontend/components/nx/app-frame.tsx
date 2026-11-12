'use client';

import { useState, type ReactNode } from 'react';
import { AppShell } from './shell';
import { CommandPalette, type PaletteAction } from './palette';
import { TooltipProvider } from './overlays';

/**
 * Client frame around every app route: the shell, the command palette and the
 * tooltip provider. Kept separate from the route-group layout so that layout can
 * stay a server component and only this subtree ships to the browser.
 */
export default function AppFrame({
  workspaceId = null,
  workspaceName,
  actions,
  children,
}: {
  workspaceId?: string | null;
  workspaceName?: string;
  actions?: PaletteAction[];
  children: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <TooltipProvider>
      <AppShell
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        onOpenPalette={() => setPaletteOpen(true)}
      >
        {children}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        workspaceId={workspaceId}
        actions={actions}
      />
    </TooltipProvider>
  );
}
