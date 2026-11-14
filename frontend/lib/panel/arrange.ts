import type { CanvasPanel, Layout } from './types';
import type { PatchOp } from './edit';

/**
 * Pure layout rules for arrange mode. The canvas surface only measures pixels;
 * everything that decides where a panel ends up lives here so the queued
 * `movePanel` operations describe exactly the layout the user sees.
 */
export type Rect = { x: number; y: number; w: number; h: number };
export type LayoutMap = Record<string, Rect>;

export const MIN_W = 2;
export const MIN_H = 2;
export const COLS_12 = 12;
export const COLS_48 = 48;

/** Snap one coordinate. `snap=false` keeps two decimals (freeform). */
export function snapValue(n: number, snap = true): number {
  if (!Number.isFinite(n)) return 0;
  return snap ? Math.round(n) : Math.round(n * 100) / 100;
}

/** Snap a rectangle and clamp it inside the grid: min size, within columns, never above row 0. */
export function clampRect(r: Rect, columns: number, snap = true): Rect {
  const w = Math.max(Math.min(MIN_W, columns), Math.min(columns, snapValue(r.w, snap)));
  const h = Math.max(MIN_H, snapValue(r.h, snap));
  return { w, h, x: Math.max(0, Math.min(columns - w, snapValue(r.x, snap))), y: Math.max(0, snapValue(r.y, snap)) };
}

/** Two rectangles overlap when they share area. Touching edges do not overlap. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Ids of rectangles that overlap another one. Empty means the layout is valid. */
export function overlappingIds(layout: LayoutMap): string[] {
  const ids = Object.keys(layout).sort();
  const hit = new Set<string>();
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (overlaps(layout[ids[i]], layout[ids[j]])) {
        hit.add(ids[i]);
        hit.add(ids[j]);
      }
  return [...hit];
}

/**
 * Reflow: `fixedId` takes `rect` (already clamped) and every other panel that now
 * collides is pushed down, in reading order, just below what it collides with.
 * Panels that do not collide never move, and nothing moves up or sideways, so the
 * result is deterministic and the number of changed panels stays small.
 */
export function reflow(base: LayoutMap, fixedId: string, rect: Rect): LayoutMap {
  const out: LayoutMap = { [fixedId]: rect };
  const placed: Rect[] = [rect];
  const rest = Object.keys(base)
    .filter((id) => id !== fixedId)
    .sort((a, b) => base[a].y - base[b].y || base[a].x - base[b].x || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of rest) {
    const r = { ...base[id] };
    for (;;) {
      const hit = placed.filter((p) => overlaps(r, p));
      if (!hit.length) break;
      r.y = Math.max(...hit.map((p) => p.y + p.h));
    }
    out[id] = r;
    placed.push(r);
  }
  return out;
}

/**
 * One arrange gesture: set `id` to `proposed` (snapped and clamped to `columns`),
 * then reflow the others. Always returns a layout with no overlaps, provided the
 * rectangles of `base` fit the grid.
 */
export function arrange(base: LayoutMap, id: string, proposed: Rect, columns: number, snap = true, mode: 'move' | 'resize' = 'move'): LayoutMap {
  // A resize keeps the left edge: the width stops at the grid edge instead of sliding the panel left.
  const p = mode === 'resize' ? { ...proposed, w: Math.min(proposed.w, columns - Math.max(0, Math.min(columns - MIN_W, proposed.x))) } : proposed;
  return reflow(base, id, clampRect(p, columns, snap));
}

/** Keyboard step: arrows move one track, shift with arrows resizes by one. */
export function keyStep(r: Rect, key: string, resizing: boolean): Rect | null {
  const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[key];
  if (!d) return null;
  return resizing ? { ...r, w: r.w + d[0], h: r.h + d[1] } : { ...r, x: r.x + d[0], y: r.y + d[1] };
}

/** Columns the layout needs: 48 as soon as any panel is wider than 12 or starts past it. */
export function columnsFor(layouts: Layout[]): number {
  return layouts.some((l) => l.w > COLS_12 || l.x >= COLS_12) ? COLS_48 : COLS_12;
}

export type MoveOp = { op: 'movePanel'; panelId: string; layout: Layout };

/** The movePanel operations that turn `panels` into `next`, one per changed panel, in panel order. */
export function diffOps(panels: CanvasPanel[], next: LayoutMap): MoveOp[] {
  return panels.flatMap((p) => {
    const r = next[p.panelId];
    if (!r || (r.x === p.layout.x && r.y === p.layout.y && r.w === p.layout.w && r.h === p.layout.h)) return [];
    return [{ op: 'movePanel' as const, panelId: p.panelId, layout: { ...p.layout, ...r } }];
  });
}

/**
 * The toolbar's Wider / Narrower / Taller / Shorter. Steps are in 12-column units
 * (a quarter on a 48-column layout), height stays between 4 and 24 rows, and
 * neighbours are reflowed like any other resize. Returns `base` when nothing changes.
 */
export function nudgeSize(base: LayoutMap, id: string, dw: number, dh: number, columns: number): LayoutMap {
  const r = base[id];
  if (!r) return base;
  const scale = columns / COLS_12;
  const w = Math.max(scale * 3, Math.min(columns - r.x, r.w + dw * scale));
  const h = Math.max(4, Math.min(24, r.h + dh));
  if (w === r.w && h === r.h) return base;
  return arrange(base, id, { ...r, w, h }, columns, true, 'resize');
}

/** Apply swap ops from `swapWithNeighbour`, then push down whatever the swap made collide. */
export function swapSettled(base: LayoutMap, ops: PatchOp[], columns: number): LayoutMap {
  const moves = ops.flatMap((o) => (o.op === 'movePanel' ? [o] : []));
  if (!moves.length) return base;
  const [first, ...others] = moves;
  const applied: LayoutMap = { ...base };
  for (const o of others) applied[o.panelId] = { x: o.layout.x, y: o.layout.y, w: o.layout.w, h: o.layout.h };
  const { x, y, w, h } = first.layout;
  return arrange(applied, first.panelId, { x, y, w, h }, columns);
}
