'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from './shell';
import { CommandPalette, type PaletteAction } from './palette';
import { TooltipProvider } from './overlays';
import SmoothScroll from './smooth-scroll';
import CreditsPopup from './credits-popup';
import { AskDock } from './ask-dock';
import { AskDockContext } from './ask-context';
import { useWorkspaceStream } from '@/lib/sse/hub';

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
  const [askOpen, setAskOpen] = useState(false);
  // The panel mounts on first open (no agent calls on pages that never use it) and then stays mounted, so a draft survives a close.
  const [askMounted, setAskMounted] = useState(false);
  useEffect(() => {
    if (askOpen) setAskMounted(true);
  }, [askOpen]);
  const router = useRouter();
  // On a workspace page the Ask panel docks beside the page, bound to that workspace. Elsewhere Ask opens the Agent page.
  const available = !!workspaceId;
  const ask = useMemo(() => ({ available, open: available && askOpen, setOpen: setAskOpen }), [available, askOpen]);
  // Cmd or Ctrl + J toggles the Ask panel (or opens the Agent page outside a workspace).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (available) setAskOpen((v) => !v);
        else router.push('/agent');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, available]);
  const paletteActions = useMemo<PaletteAction[]>(
    () => [{ id: 'ask-agent', group: 'Agent', label: 'Ask the agent a research question', hint: '⌘J', run: () => (available ? setAskOpen(true) : router.push('/agent')) }, ...(actions ?? [])],
    [actions, router, available],
  );
  // One live event stream per open workspace; events invalidate the query cache.
  useWorkspaceStream(workspaceId);
  return (
    <TooltipProvider>
      <SmoothScroll />
      <AskDockContext.Provider value={ask}>
        <AppShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          onOpenPalette={() => setPaletteOpen(true)}
          aside={workspaceId && askMounted ? <AskDock key={workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} onClose={() => setAskOpen(false)} /> : undefined}
        >
          {children}
        </AppShell>
      </AskDockContext.Provider>
      <CreditsPopup />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        workspaceId={workspaceId}
        actions={paletteActions}
      />
    </TooltipProvider>
  );
}
