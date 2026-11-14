'use client';

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Badge } from '@/components/nx/evidence';
import { Card, Notice, Textarea } from '@/components/nx/ui';
import { useCollab } from '@/lib/collab/use-collab';

const MAX = 20_000;

/** Map an index through a Yjs text delta (used to keep a collaborator's caret where it was). */
function shift(delta: { retain?: number; insert?: string | object; delete?: number }[], index: number): number {
  let pos = 0;
  let out = index;
  for (const d of delta) {
    if (d.retain) pos += d.retain;
    else if (typeof d.insert === 'string') {
      if (pos <= index) out += d.insert.length;
      pos += 0;
    } else if (d.delete) {
      if (pos < index) out -= Math.min(d.delete, index - pos);
    }
  }
  return Math.max(0, out);
}

/**
 * Shared notes for one panel, edited live by everyone in the workspace over the Yjs socket (scope `notes`).
 * Notes are discussion text only: they carry no evidence, and nothing here changes the canvas, markers or any other
 * persisted state, which move only through commands. The server validates and stores every update.
 */
export function SharedNotes({ wid, panelId }: { wid: string; panelId: string }) {
  const p = useCollab(wid, 'notes', { notesFor: panelId });
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const textRef = useRef('');

  useEffect(() => {
    if (!p) return;
    const map = p.doc.getMap<Y.Text>('notes');
    let bound: Y.Text | null = null;
    const onText = (ev: Y.YTextEvent) => {
      const el = ta.current;
      const next = bound!.toString();
      const caret = el && document.activeElement === el ? [el.selectionStart, el.selectionEnd] : null;
      textRef.current = next;
      setText(next);
      if (el && caret && !ev.transaction.local) {
        const d = ev.delta as Parameters<typeof shift>[0];
        requestAnimationFrame(() => el.setSelectionRange(shift(d, caret[0]!), shift(d, caret[1]!)));
      }
    };
    const bind = () => {
      const t = map.get(panelId) ?? null;
      if (t === bound) return;
      bound?.unobserve(onText);
      bound = t;
      if (t) {
        t.observe(onText);
        textRef.current = t.toString();
        setText(textRef.current);
      }
    };
    map.observe(bind);
    bind();
    return () => {
      map.unobserve(bind);
      bound?.unobserve(onText);
    };
  }, [p, panelId]);

  const edit = (next: string) => {
    if (!p || next.length > MAX) return;
    const prev = textRef.current;
    let a = 0;
    while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
    let b = 0;
    while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
    p.doc.transact(() => {
      const map = p.doc.getMap<Y.Text>('notes');
      let t = map.get(panelId);
      if (!t) {
        t = new Y.Text();
        map.set(panelId, t);
      }
      if (prev.length - a - b > 0) t.delete(a, prev.length - a - b);
      if (next.length - a - b > 0) t.insert(a, next.slice(a, next.length - b));
    });
  };

  const status = p?.status ?? 'connecting';
  return (
    <Card
      title="Shared notes"
      subtitle="Everyone in this workspace sees edits as they are made. Notes are text only and change nothing else."
      actions={
        <span data-testid="notes-status" data-status={status} data-peers={p?.peers.length ?? 0}>
          <Badge tone={status === 'open' ? 'ok' : status === 'revoked' || status === 'denied' ? 'bad' : 'warn'} outline>
            {status === 'open' ? `live${p && p.peers.length > 1 ? `, ${p.peers.length} here` : ''}` : status === 'revoked' ? 'access revoked' : status === 'denied' ? 'no access' : status === 'connecting' ? 'connecting' : 'reconnecting'}
          </Badge>
        </span>
      }
    >
      {status === 'revoked' ? (
        <Notice tone="bad" title="Your access to this workspace was revoked">
          The live connection was closed by the server. Notes are no longer shared with you.
        </Notice>
      ) : (
        <>
          <Textarea
            ref={ta}
            rows={5}
            aria-label="Shared notes"
            data-testid="shared-notes"
            value={text}
            disabled={status === 'denied'}
            placeholder={status === 'open' ? 'Write a note for this panel' : 'Connecting to the shared document'}
            onChange={(e) => edit(e.target.value)}
          />
          {p?.lastError && (
            <div className="small" role="alert" data-testid="notes-error" style={{ marginTop: 6 }}>
              The server did not accept the last edit: {p.lastError.reasonCode || p.lastError.code}.
            </div>
          )}
        </>
      )}
    </Card>
  );
}
