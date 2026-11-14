'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { allRoutes } from '@/lib/nav';

/**
 * Command palette, spec 2.3: Cmd/Ctrl+K for navigation, search and permitted
 * actions.
 *
 * Only routes and actions the principal can reach are listed. An action the
 * user cannot perform is absent rather than present and failing, which is the
 * one place the spec prefers hiding to disabling, since the palette is a
 * search surface and a dead result is worse than no result.
 */

export type PaletteAction = {
  id: string;
  label: string;
  group: string;
  run: () => void;
  hint?: string;
};

export function CommandPalette({
  open,
  onOpenChange,
  workspaceId = null,
  actions = [],
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId?: string | null;
  actions?: PaletteAction[];
}) {
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === 'Escape' && open) onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  const routes = allRoutes(workspaceId);

  // The Agent first, then view actions, then whatever a screen contributed.
  const grouped = actions.reduce<Record<string, PaletteAction[]>>((acc, a) => {
    (acc[a.group] ??= []).push(a);
    return acc;
  }, {});
  const preferred = ['Agent', 'View'];
  const groupOrder = [...preferred.filter((g) => grouped[g]), ...Object.keys(grouped).filter((g) => !preferred.includes(g))];

  return (
    <>
      <div className="scrim" onClick={() => onOpenChange(false)} />
      <Command className="palette" label="Command palette" loop>
        <Command.Input autoFocus placeholder="Search screens, metrics and actions" />
        <Command.List>
          <Command.Empty>No matches.</Command.Empty>

          {groupOrder.map((group) => (
            <Command.Group key={group} heading={group}>
              {grouped[group].map((a) => (
                <Command.Item
                  key={a.id}
                  value={`${a.label} ${a.hint ?? ''}`}
                  className="menu-item"
                  onSelect={() => {
                    onOpenChange(false);
                    a.run();
                  }}
                >
                  <span className="grow">{a.label}</span>
                  {a.hint && <kbd className="tiny dim mono">{a.hint}</kbd>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}

          <Command.Group heading="Go to">
            {routes.map((r) => (
              <Command.Item
                key={r.href}
                value={`${r.label} ${r.hint ?? ''} ${r.href}`}
                className="menu-item"
                onSelect={() => {
                  onOpenChange(false);
                  router.push(r.href);
                }}
              >
                <r.icon size={14} strokeWidth={1.75} />
                <span className="grow">{r.label}</span>
                {r.hint && <span className="tiny dim">{r.hint}</span>}
              </Command.Item>
            ))}
          </Command.Group>

        </Command.List>
      </Command>
    </>
  );
}
