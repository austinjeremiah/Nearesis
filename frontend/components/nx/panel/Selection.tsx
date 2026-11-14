'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@/components/nx/ui';
import { fmtTime, timeExtent, toTime } from '@/lib/panel/model';
import { panelSelection, usePanelSelection, useSelectionActions } from '@/lib/panel/selection';
import type { CanvasPanel, PanelData } from '@/lib/panel/types';
import { bind } from '@/lib/panel/model';

/** Shows the current range selection and the actions other pages registered for it. A selection alone writes nothing. */
export function SelectionBar({ wid, titles }: { wid: string; titles?: Record<string, string> }) {
  const sel = usePanelSelection();
  const actions = useSelectionActions();
  if (!sel || sel.workspaceId !== wid) return null;
  return (
    <div className="row gap2 nxp-bar" role="status" data-testid="selection-bar">
      <span className="label">Selection</span>
      <span className="small">{titles?.[sel.panelId] ?? sel.panelId.slice(0, 8)}</span>
      <span className="mono small" data-testid="selection-range">
        {sel.start.slice(0, 16)}Z to {sel.end.slice(0, 16)}Z
      </span>
      <span className="tiny dim">Nothing is created until you act on it.</span>
      {actions.map((a, i) => (
        <span key={i}>{a(sel)}</span>
      ))}
      <Button variant="ghost" onClick={() => panelSelection.clear()}>
        Clear
      </Button>
    </div>
  );
}

/** Keyboard path to the same selection a drag makes. */
export function RangeSelectForm({ wid, panel, data }: { wid: string; panel: CanvasPanel; data: PanelData }) {
  const ext = timeExtent(panel, data);
  const [from, setFrom] = useState(ext ? fmtTime(ext.start) : '');
  const [to, setTo] = useState(ext ? fmtTime(ext.end) : '');
  if (!ext) return null;
  const s = toTime(from);
  const e = toTime(to);
  const valid = s !== null && e !== null && s <= e;
  const col = bind(panel, data).x ?? '';
  return (
    <form
      className="row gap2"
      style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!valid) return;
        panelSelection.set({ workspaceId: wid, panelId: panel.panelId, queryHash: data.queryHash, seriesId: col, start: new Date(s!).toISOString(), end: new Date(e!).toISOString(), origin: 'form', sourceWatermark: data.chart?.sourceWatermark ?? null });
      }}
      aria-label="Select a time range"
    >
      <Field label="From (UTC date)">
        <Input value={from} onChange={(ev) => setFrom(ev.target.value)} placeholder="2026-01-01" data-testid="range-from" />
      </Field>
      <Field label="To (UTC date)">
        <Input value={to} onChange={(ev) => setTo(ev.target.value)} placeholder="2026-02-01" data-testid="range-to" />
      </Field>
      <Button type="submit" disabled={!valid} disabledReason="Enter two valid dates, from before to." data-testid="range-select">
        Select range
      </Button>
    </form>
  );
}
