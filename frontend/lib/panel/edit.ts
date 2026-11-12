import type { CanvasDocument, CanvasPanel, Layout } from './types';

/**
 * Canvas edits as `workspace.patch` documents (canvas.apply_patch). Each edit has
 * an inverse, so undo and redo are patches too and every step is a real revision.
 */
export type PatchOp =
  | { op: 'movePanel'; panelId: string; layout: Layout }
  | { op: 'removePanel'; panelId: string }
  | { op: 'addPanel'; panel: CanvasPanel };

export const GRID_COLS = 12;
export const ROW_PX = 44;

/** Reading order: top to bottom, then left to right. The canvas flows panels in this order. */
export function ordered(panels: CanvasPanel[]): CanvasPanel[] {
  return [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x || a.panelId.localeCompare(b.panelId));
}

/** Column span on the 12-column grid (layouts may use up to 48 columns). */
export function spanOf(layout: Layout): number {
  const w = layout.w > GRID_COLS ? Math.ceil(layout.w / 4) : layout.w;
  return Math.max(3, Math.min(GRID_COLS, w));
}

export function inverse(doc: CanvasDocument, ops: PatchOp[]): PatchOp[] {
  const by = new Map(doc.panels.map((p) => [p.panelId, p] as const));
  const out: PatchOp[] = [];
  for (const o of [...ops].reverse()) {
    const p = by.get(o.op === 'addPanel' ? o.panel.panelId : o.panelId);
    if (o.op === 'movePanel' && p) out.push({ op: 'movePanel', panelId: p.panelId, layout: p.layout });
    else if (o.op === 'removePanel' && p) out.push({ op: 'addPanel', panel: p });
    else if (o.op === 'addPanel') out.push({ op: 'removePanel', panelId: o.panel.panelId });
  }
  return out;
}

/** Swap the reading positions of a panel and its neighbour in `dir`. */
export function swapWithNeighbour(doc: CanvasDocument, panelId: string, dir: -1 | 1): PatchOp[] | null {
  const list = ordered(doc.panels);
  const i = list.findIndex((p) => p.panelId === panelId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  const a = list[i];
  const b = list[j];
  // Give each the other's origin. When both share one origin (overlapping layouts), nudge the moved panel one row.
  const same = a.layout.x === b.layout.x && a.layout.y === b.layout.y;
  const aTo = same ? { ...a.layout, y: dir < 0 ? Math.max(0, b.layout.y - 1) : b.layout.y + 1 } : { ...a.layout, x: b.layout.x, y: b.layout.y };
  const bTo = same ? b.layout : { ...b.layout, x: a.layout.x, y: a.layout.y };
  const ops: PatchOp[] = [{ op: 'movePanel', panelId: a.panelId, layout: aTo }];
  if (!same) ops.push({ op: 'movePanel', panelId: b.panelId, layout: bTo });
  return ops;
}

export function resize(panel: CanvasPanel, dw: number, dh: number): PatchOp[] | null {
  const scale = panel.layout.w > GRID_COLS ? 4 : 1;
  const w = Math.max(scale * 3, Math.min(scale * GRID_COLS, panel.layout.w + dw * scale));
  const h = Math.max(4, Math.min(24, panel.layout.h + dh));
  if (w === panel.layout.w && h === panel.layout.h) return null;
  return [{ op: 'movePanel', panelId: panel.panelId, layout: { ...panel.layout, w, h } }];
}

export function buildPatch(doc: CanvasDocument, ops: PatchOp[], operationId: string) {
  return { schemaVersion: 1 as const, type: 'workspace.patch' as const, operationId, expectedRevision: doc.documentRevision, operations: ops };
}

/** Apply ops to a document locally, for diff display only. The server stays the authority. */
export function previewDoc(doc: CanvasDocument, ops: PatchOp[]): CanvasPanel[] {
  let panels = doc.panels;
  for (const o of ops) {
    if (o.op === 'movePanel') panels = panels.map((p) => (p.panelId === o.panelId ? { ...p, layout: o.layout } : p));
    else if (o.op === 'removePanel') panels = panels.filter((p) => p.panelId !== o.panelId);
    else panels = [...panels, o.panel];
  }
  return panels;
}
