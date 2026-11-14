'use client';

import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { Badge } from '@/components/nx/evidence';
import { useCollab } from '@/lib/collab/use-collab';

type Pos = { x: number; y: number };
type Move = { panelId: string; layout: { x: number; y: number } };
type Panel = { panelId: string; title: string; layout: { x: number; y: number } };

/**
 * Live layout drafts over the Yjs socket (scope `layout`). While someone edits the layout, the positions they have
 * queued (not yet applied) are shared as drafts so collaborators see who is about to move what. A draft is a hint:
 * the canvas changes only when a person applies it, which goes through `canvas.apply_patch` with its revision check.
 * The server keeps only entries shaped {x, y}; a draft for a panel that no longer exists is ignored here and dropped
 * by the server's reconcile.
 */
export function LayoutLive({ wid, moves, panels }: { wid: string; moves: Move[]; panels: Panel[] }) {
  const p = useCollab(wid, 'layout');
  const mine = useRef(new Set<string>());
  const synced = !!p?.synced;

  useEffect(() => {
    if (!p || !synced) return;
    const map = p.doc.getMap<Pos>('layout');
    p.doc.transact(() => {
      const want = new Map(moves.map((m) => [m.panelId, { x: m.layout.x, y: m.layout.y }] as const));
      for (const [id, pos] of want) {
        const cur = map.get(id);
        if (!cur || cur.x !== pos.x || cur.y !== pos.y) map.set(id, pos);
        mine.current.add(id);
      }
      for (const id of [...mine.current]) {
        if (!want.has(id)) {
          map.delete(id);
          mine.current.delete(id);
        }
      }
    });
  }, [p, synced, moves]);

  useEffect(() => {
    const ids = mine.current;
    const doc = p?.doc;
    return () => {
      // leaving the page withdraws this person's drafts
      if (!doc || doc.isDestroyed) return;
      const map = doc.getMap<Pos>('layout');
      doc.transact(() => ids.forEach((id) => map.delete(id)));
    };
  }, [p]);

  const status = p?.status ?? 'connecting';
  const map: Y.Map<Pos> | null = p ? p.doc.getMap<Pos>('layout') : null;
  const theirs = panels
    .map((pl) => ({ pl, d: map?.get(pl.panelId) }))
    .filter((x) => x.d && !mine.current.has(x.pl.panelId) && (x.d.x !== x.pl.layout.x || x.d.y !== x.pl.layout.y));
  return (
    <div className="col gap1" data-testid="layout-live" data-status={status} data-drafts={theirs.length}>
      <div className="row gap2">
        <Badge tone={status === 'open' ? 'ok' : status === 'revoked' || status === 'denied' ? 'bad' : 'warn'} outline>
          {status === 'open' ? 'layout live' : status === 'revoked' ? 'layout access revoked' : status === 'denied' ? 'layout: no access' : 'layout reconnecting'}
        </Badge>
        {theirs.length > 0 && <span className="tiny dim">Draft positions from collaborators are not applied until someone applies them.</span>}
      </div>
      {theirs.map(({ pl, d }) => (
        <div key={pl.panelId} className="small" data-testid="layout-draft">
          A collaborator is moving <strong>{pl.title}</strong> to x{d!.x} y{d!.y}.
        </div>
      ))}
    </div>
  );
}
