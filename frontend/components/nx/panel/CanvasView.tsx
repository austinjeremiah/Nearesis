'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsLeftRight, Redo2, Trash2, Undo2 } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { Button, Card, EmptyState, Field, IconButton, Input, Notice, Skeleton } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';
import { ordered, spanOf, swapWithNeighbour } from '@/lib/panel/edit';
import { arrange, columnsFor, diffOps, nudgeSize, swapSettled } from '@/lib/panel/arrange';
import { CanvasGrid, type LayoutMap, type Rect } from '@/components/nx/canvas-grid';
import { useCanvas, useCanvasEditor, useLenses, useLensCommands, useLensResolution, usePanelProgress } from '@/lib/panel/hooks';
import { usePanelSelection } from '@/lib/panel/selection';
import { toTime } from '@/lib/panel/model';
import type { CanvasPanel } from '@/lib/panel/types';
import { layoutHeight, PanelBody, PanelFrame, useNearViewport } from './PanelFrame';
import { MarkerSelectionAction } from '@/components/nx/marker-selection-action';
import { SelectionBar } from './Selection';
import { LayoutLive } from '@/components/nx/layout-live';
import './panel.css';

function PanelCell({
  wid,
  panel,
  markers,
  progress,
  window: win,
  dim,
  pending,
  edit,
  lensPick,
  height,
}: {
  wid: string;
  panel: CanvasPanel;
  markers: import('@/lib/panel/types').CanvasMarker[];
  progress?: { status: 'QUERYING' | 'READY' | 'ERROR'; reason?: string };
  window: { start: string; end: string } | null;
  dim: boolean;
  pending: boolean;
  edit?: React.ReactNode;
  lensPick?: React.ReactNode;
  /** Set in arrange mode, where the cell's own rectangle decides the height. */
  height?: number;
}) {
  const { ref, near } = useNearViewport();
  const sel = usePanelSelection();
  return (
    <div className={height ? 'nxp-cell fill' : 'nxp-cell'} ref={ref} style={{ ['--span' as string]: spanOf(panel.layout) }}>
      <PanelFrame wid={wid} panel={panel} enabled={near} dim={dim} pending={pending} edit={edit} tools={lensPick}>
        <PanelBody wid={wid} panel={panel} height={height ?? layoutHeight(panel)} enabled={near} progress={progress} markers={markers} window={win} brush={panel.kind === 'timeSeries' || panel.kind === 'bar'} />
        {sel?.panelId === panel.panelId && <div className="tiny dim" style={{ padding: '0 10px 6px' }}>Selected {sel.start.slice(0, 10)} to {sel.end.slice(0, 10)}</div>}
      </PanelFrame>
    </div>
  );
}

export default function CanvasView({ wid }: { wid: string }) {
  const canvas = useCanvas(wid);
  const doc = canvas.data;
  const progress = usePanelProgress(wid);
  const ed = useCanvasEditor(wid, doc);
  const lenses = useLenses(wid);
  const lensCmd = useLensCommands(wid);
  const [editing, setEditing] = useState(false);
  const [lensId, setLensId] = useState<string | null>(null);
  const resolution = useLensResolution(wid, lensId);
  const [naming, setNaming] = useState(false);
  const [lensName, setLensName] = useState('');
  const [lensFrom, setLensFrom] = useState('');
  const [lensTo, setLensTo] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [live, setLive] = useState<LayoutMap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const panels = useMemo(() => ordered(ed.draftPanels.length || ed.pending.length ? ed.draftPanels : (doc?.panels ?? [])), [ed.draftPanels, ed.pending.length, doc]);
  const titles = useMemo(() => Object.fromEntries((doc?.panels ?? []).map((p) => [p.panelId, p.title])), [doc]);
  const lens = lenses.data?.lenses.find((l) => l.lensId === lensId) ?? null;
  const res = new Map((resolution.data?.panels ?? []).map((p) => [p.panelId, p] as const));

  const moves = useMemo(() => ed.pending.flatMap((o) => (o.op === 'movePanel' ? [{ panelId: o.panelId, layout: o.layout }] : [])), [ed.pending]);

  if (canvas.isPending) return <Skeleton rows={6} />;
  if (canvas.isError) return <ApiErrorState error={canvas.error} onRetry={() => canvas.refetch()} />;
  if (!doc) return null;

  const fromD = toTime(lensFrom);
  const toD = toTime(lensTo);
  const lensValid = lensName.trim().length > 0 && pick.size > 0 && (lensFrom === '' && lensTo === '' ? true : fromD !== null && toD !== null && fromD <= toD);

  const arrangeCols = columnsFor(panels.map((p) => p.layout));
  const ARRANGE_ROW = 44;
  const ARRANGE_GAP = 12;
  const baseLayout: LayoutMap = Object.fromEntries(panels.map((p) => [p.panelId, { x: p.layout.x, y: p.layout.y, w: p.layout.w, h: p.layout.h }]));
  const nudge = (p: CanvasPanel, dw: number, dh: number) => ed.queue(diffOps(panels, nudgeSize(baseLayout, p.panelId, dw, dh, arrangeCols)));
  const swap = (p: CanvasPanel, dir: -1 | 1) => {
    const ops = swapWithNeighbour({ ...doc, panels }, p.panelId, dir);
    if (ops) ed.queue(diffOps(panels, swapSettled(baseLayout, ops, arrangeCols)));
  };
  const commitLayout = (next: LayoutMap) => {
    setLive(null);
    const ops = diffOps(panels, next);
    if (ops.length) ed.queue(ops);
  };
  const renderPanel = (p: CanvasPanel, idx: number, height?: number) => {
            const r = res.get(p.panelId);
            const inLens = !lens || (lens.panelIds.includes(p.panelId) && r?.compatible !== false);
            const win = lens && inLens ? (r?.appliedFilter?.timeRange ?? lens.filter.timeRange ?? null) : null;
            const pend = ed.pending.some((o) => (o.op === 'addPanel' ? o.panel.panelId : o.panelId) === p.panelId);
            return (
              <PanelCell
                key={p.panelId}
                wid={wid}
                panel={p}
                markers={doc.markers ?? []}
                progress={progress[p.panelId]}
                window={win}
                dim={!!lens && !inLens}
                pending={pend}
                height={height}
                lensPick={
                  naming ? (
                    <label className="small row gap1">
                      <input type="checkbox" checked={pick.has(p.panelId)} onChange={(e) => setPick((s) => { const n = new Set(s); e.target.checked ? n.add(p.panelId) : n.delete(p.panelId); return n; })} data-testid="lens-pick" />
                      In lens
                    </label>
                  ) : undefined
                }
                edit={
                  editing ? (
                    <div className="nxp-edit" role="group" aria-label={`Edit ${p.title}`}>
                      <IconButton label="Move earlier" disabled={idx === 0} onClick={() => swap(p, -1)} data-testid="move-earlier">
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton label="Move later" disabled={idx === panels.length - 1} onClick={() => swap(p, 1)} data-testid="move-later">
                        <ArrowDown size={14} />
                      </IconButton>
                      <IconButton label="Wider" onClick={() => nudge(p, 3, 0)} data-testid="wider">
                        <ChevronsLeftRight size={14} />
                      </IconButton>
                      <Button variant="ghost" onClick={() => nudge(p, -3, 0)}>Narrower</Button>
                      <Button variant="ghost" onClick={() => nudge(p, 0, 2)}>Taller</Button>
                      <Button variant="ghost" onClick={() => nudge(p, 0, -2)}>Shorter</Button>
                      <Button variant="ghost" onClick={() => ed.queue([{ op: 'removePanel', panelId: p.panelId }])} data-testid="remove-panel">
                        Remove
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            );
          };

  return (
    <div className="col gap3">
      <div className="nxp-bar" role="toolbar" aria-label="Canvas">
        <span data-testid="canvas-revision"><Badge outline>Revision {doc.documentRevision}</Badge></span>
        <Badge outline>{doc.panels.length} panel{doc.panels.length === 1 ? '' : 's'}</Badge>
        {doc.updatedAt && <span className="tiny dim">updated {formatUtc(doc.updatedAt)}</span>}
        <div className="grow" />
        <IconButton label="Undo last applied change" onClick={ed.undo} disabled={!ed.canUndo || ed.busy} data-testid="undo">
          <Undo2 size={15} />
        </IconButton>
        <IconButton label="Redo" onClick={ed.redo} disabled={!ed.canRedo || ed.busy} data-testid="redo">
          <Redo2 size={15} />
        </IconButton>
        <Button variant={editing ? 'primary' : 'secondary'} aria-pressed={editing} onClick={() => setEditing((v) => !v)} data-testid="edit-toggle">
          {editing ? 'Done editing' : 'Edit layout'}
        </Button>
      </div>

      <LayoutLive wid={wid} moves={moves} panels={doc.panels} />
      <MarkerSelectionAction />
      <SelectionBar wid={wid} titles={titles} />

      {/* pending patch: preview, apply with If-Match, discard */}
      {ed.pending.length > 0 && (
        <Card title={`Pending change, ${ed.pending.length} operation${ed.pending.length === 1 ? '' : 's'}`} subtitle="Shown dashed on the canvas. Nothing is saved until you apply it.">
          <ul className="nxp-diff" style={{ margin: 0, paddingLeft: 18 }} data-testid="pending-diff">
            {ed.pending.map((o, i) => (
              <li key={i}>
                {o.op === 'movePanel' ? `move "${titles[o.panelId] ?? o.panelId}" to x${o.layout.x} y${o.layout.y} w${o.layout.w} h${o.layout.h}` : o.op === 'removePanel' ? `remove "${titles[o.panelId] ?? o.panelId}"` : `add "${o.panel.title}"`}
              </li>
            ))}
          </ul>
          {ed.preview.data && (
            <div className="small" style={{ marginTop: 8 }} data-testid="preview-result">
              <Badge tone="ok">Preview valid</Badge> {ed.preview.data.estimate.queryCount} quer{ed.preview.data.estimate.queryCount === 1 ? 'y' : 'ies'} to run, about {ed.preview.data.estimate.estimatedRows.toLocaleString('en-US')} rows, estimated cost{' '}
              {ed.preview.data.estimate.estimatedCostUsd === null ? 'unknown' : `$${ed.preview.data.estimate.estimatedCostUsd.toFixed(2)}`}. Base revision {ed.preview.data.baseRevision}.
              {ed.preview.data.estimate.atRiskPanelIds.length > 0 && <> {ed.preview.data.estimate.atRiskPanelIds.length} panel(s) at risk.</>}
              <div className="tiny dim">{ed.preview.data.estimate.costBasis}</div>
            </div>
          )}
          <div className="row gap2" style={{ marginTop: 10 }}>
            <Button onClick={() => ed.preview.mutate()} pending={ed.preview.isPending} data-testid="preview-patch">
              Preview
            </Button>
            <Button variant="primary" onClick={() => ed.apply.mutate()} pending={ed.apply.isPending} data-testid="apply-patch">
              Apply
            </Button>
            <Button variant="ghost" onClick={ed.discard} data-testid="discard-patch">
              Discard
            </Button>
          </div>
        </Card>
      )}
      {ed.error?.kind === 'conflict' && (
        <Notice tone="warn" title="The canvas changed elsewhere">
          Your edit was based on an older version (409 STALE_VERSION){ed.error.lastStableRevision !== null ? `, latest stable revision ${ed.error.lastStableRevision}` : ''}. Reload to see the current canvas; your pending edits are kept and can be applied again.
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => void ed.reload()} data-testid="reload-canvas">
              Reload and keep my edits
            </Button>
          </div>
        </Notice>
      )}
      {ed.error?.kind === 'rejected' && (
        <Notice tone="bad" title="The patch was rejected">
          {ed.error.message}
          {ed.error.issues.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {ed.error.issues.slice(0, 6).map((i, k) => (
                <li key={k}>
                  <span className="mono">{i.path}</span> {i.issue}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      {ed.error?.kind === 'other' && (
        <Notice tone="bad" title="The change did not apply">
          {ed.error.message}
        </Notice>
      )}

      {/* lenses */}
      <Card
        title="Lenses"
        subtitle="A lens applies one shared time window to several panels without changing their metric definitions."
        actions={
          <Button onClick={() => setNaming((v) => !v)} aria-expanded={naming} data-testid="lens-new">
            {naming ? 'Cancel' : 'New lens'}
          </Button>
        }
      >
        <div className="row gap2" style={{ flexWrap: 'wrap' }} data-testid="lens-list">
          {lenses.isPending && <span className="small dim">Loading lenses</span>}
          {lenses.data?.lenses.length === 0 && !naming && <span className="small dim">No lenses yet.</span>}
          {lenses.data?.lenses.map((l) => (
            <span key={l.lensId} className="row gap1">
              <Button variant={l.lensId === lensId ? 'primary' : 'secondary'} aria-pressed={l.lensId === lensId} onClick={() => setLensId(l.lensId === lensId ? null : l.lensId)} data-testid="lens-apply">
                {l.name}
              </Button>
              <IconButton label={`Delete lens ${l.name}`} onClick={() => lensCmd.remove.mutate(l.lensId, { onSuccess: () => l.lensId === lensId && setLensId(null) })} data-testid="lens-delete">
                <Trash2 size={14} />
              </IconButton>
            </span>
          ))}
        </div>
        {lens && (
          <div className="small" style={{ marginTop: 8 }} data-testid="lens-status">
            Applied <strong>{lens.name}</strong>
            {lens.filter.timeRange ? `: ${lens.filter.timeRange.start.slice(0, 10)} to ${lens.filter.timeRange.end.slice(0, 10)}` : ''}. {[...res.values()].filter((p) => !p.compatible).length} incompatible panel(s) are dimmed and keep their own range.
          </div>
        )}
        {naming && (
          <form
            className="row gap2"
            style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!lensValid) return;
              const filter = lensFrom ? { timeRange: { start: new Date(fromD!).toISOString(), end: new Date(toD!).toISOString() } } : {};
              lensCmd.create.mutate({ name: lensName.trim(), panelIds: [...pick], filter }, { onSuccess: () => (setNaming(false), setLensName(''), setPick(new Set()), setLensFrom(''), setLensTo('')) });
            }}
          >
            <Field label="Name">
              <Input value={lensName} onChange={(e) => setLensName(e.target.value)} data-testid="lens-name" />
            </Field>
            <Field label="From (UTC date)">
              <Input value={lensFrom} onChange={(e) => setLensFrom(e.target.value)} placeholder="2026-09-01" data-testid="lens-from" />
            </Field>
            <Field label="To (UTC date)">
              <Input value={lensTo} onChange={(e) => setLensTo(e.target.value)} placeholder="2026-10-01" data-testid="lens-to" />
            </Field>
            <Button type="submit" variant="primary" pending={lensCmd.create.isPending} disabled={!lensValid} disabledReason="Name the lens, tick at least one panel, and give both dates or neither." data-testid="lens-create">
              Create lens ({pick.size} panel{pick.size === 1 ? '' : 's'})
            </Button>
            <span className="tiny dim">Tick the panels it applies to below.</span>
          </form>
        )}
        {lensCmd.create.isError && <Notice tone="bad" title="Lens not created">{String((lensCmd.create.error as Error).message)}</Notice>}
      </Card>

      {panels.length === 0 ? (
        <EmptyState title="No panels yet" body="Ask a question in Investigate. Approved panels appear here as their queries complete." />
      ) : (
        editing ? (
          <div data-testid="canvas-grid" data-mode="arrange">
          <CanvasGrid
            ids={panels.map((p) => p.panelId)}
            layout={live ?? baseLayout}
            onLayoutChange={setLive}
            onCommit={commitLayout}
            columns={arrangeCols}
            rowHeight={ARRANGE_ROW}
            gap={ARRANGE_GAP}
            showGrid
            selectedId={selected}
            onSelect={setSelected}
            renderItem={(id, rect: Rect) => {
              const idx = panels.findIndex((q) => q.panelId === id);
              const p = panels[idx];
              return p ? renderPanel(p, idx, Math.max(120, rect.h * ARRANGE_ROW + (rect.h - 1) * ARRANGE_GAP - 190)) : null;
            }}
          />
          </div>
        ) : (
        <div className="nxp-grid" data-testid="canvas-grid">
          {panels.map((p, idx) => renderPanel(p, idx))}
        </div>
        )
      )}
    </div>
  );
}
