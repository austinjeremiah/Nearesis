'use client';

import { Sparkles } from 'lucide-react';
import { Button } from './ui';
import { useAskDock } from './ask-context';

/** The page header's "Ask AI to build or edit": opens the docked Ask panel for this workspace. */
export function AskOpenButton({ children = 'Ask AI to build or edit' }: { children?: string }) {
  const ask = useAskDock();
  return (
    <Button variant="primary" onClick={() => ask.setOpen(true)} data-testid="ask-open">
      <Sparkles size={14} />
      {children}
    </Button>
  );
}
