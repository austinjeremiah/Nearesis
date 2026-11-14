'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from './shell';
import { CommandPalette, type PaletteAction } from './palette';
import { TooltipProvider } from './overlays';
import SmoothScroll from './smooth-scroll';
import CreditsPopup from './credits-popup';
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
  const router = useRouter();
  // Cmd or Ctrl + J opens the Agent, the same shortcut the palette advertises.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        router.push('/agent');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);
  const paletteActions = useMemo<PaletteAction[]>(
    () => [{ id: 'ask-agent', group: 'Agent', label: 'Ask the agent a research question', hint: '⌘J', run: () => router.push('/agent') }, ...(actions ?? [])],
    [actions, router],
  );
  // One live event stream per open workspace; events invalidate the query cache.
  useWorkspaceStream(workspaceId);
  return (
    <TooltipProvider>
      <SmoothScroll />
      <AppShell
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        onOpenPalette={() => setPaletteOpen(true)}
      >
        {children}
      </AppShell>
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
