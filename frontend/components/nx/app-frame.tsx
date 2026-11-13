'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppShell } from './shell';
import { AskPanel } from './ask-panel';
import { CommandPalette, type PaletteAction } from './palette';
import { TooltipProvider } from './overlays';

/**
 * Client frame around every app route: the shell, the agent panel, the command
 * palette and the tooltip provider. Kept separate from the route-group layout
 * so that layout can stay a server component and only this subtree ships to the
 * browser.
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
  const [askOpen, setAskOpen] = useState(false);

  const toggleAsk = useCallback(() => setAskOpen((v) => !v), []);

  // Cmd or Ctrl + J, the same shortcut the palette advertises.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleAsk();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleAsk]);

  // Theme is a display preference, so it lives in browser storage and nowhere
  // near the authority the spec keeps on the server.
  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('nx.theme', next);
    } catch {
      /* blocked storage is not an error */
    }
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('nx.theme');
      if (saved) document.documentElement.dataset.theme = saved;
    } catch {
      /* ignore */
    }
  }, []);

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: 'ask',
        group: 'Agent',
        label: 'Ask a research question',
        hint: '⌘J',
        run: () => setAskOpen(true),
      },
      {
        id: 'ask-toggle',
        group: 'Agent',
        label: askOpen ? 'Hide agent panel' : 'Show agent panel',
        run: toggleAsk,
      },
      {
        id: 'theme',
        group: 'View',
        label: 'Switch theme',
        run: toggleTheme,
      },
      ...(actions ?? []),
    ],
    [actions, askOpen, toggleAsk, toggleTheme],
  );

  return (
    <TooltipProvider>
      <AppShell
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        onOpenPalette={() => setPaletteOpen(true)}
        asideOpen={askOpen}
        onToggleAside={toggleAsk}
        aside={
          <AskPanel
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            onClose={() => setAskOpen(false)}
          />
        }
      >
        {children}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        workspaceId={workspaceId}
        actions={paletteActions}
      />
    </TooltipProvider>
  );
}
