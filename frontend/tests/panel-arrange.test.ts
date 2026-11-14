import { describe, expect, it } from 'vitest';
import { arrange, clampRect, columnsFor, diffOps, keyStep, nudgeSize, overlappingIds, overlaps, reflow, snapValue, swapSettled, type LayoutMap } from '@/lib/panel/arrange';
import type { CanvasPanel } from '@/lib/panel/types';

const panel = (id: string, x: number, y: number, w: number, h: number): CanvasPanel => ({ panelId: id, kind: 'timeSeries', title: id, layout: { x, y, w, h } });
const grid = (cols: number): LayoutMap => {
  const s = cols / 12;
  return { a: { x: 0, y: 0, w: 6 * s, h: 6 }, b: { x: 6 * s, y: 0, w: 6 * s, h: 6 }, c: { x: 0, y: 6, w: 6 * s, h: 6 }, d: { x: 6 * s, y: 6, w: 6 * s, h: 6 } };
};

describe('snap and clamp', () => {
  it('snaps to whole tracks, or two decimals when freeform', () => {
    expect(snapValue(2.6)).toBe(3);
    expect(snapValue(2.456, false)).toBe(2.46);
    expect(snapValue(NaN)).toBe(0);
  });
  it('clamps inside the grid for 12 and 48 columns', () => {
    expect(clampRect({ x: 11, y: -3, w: 6, h: 6 }, 12)).toEqual({ x: 6, y: 0, w: 6, h: 6 });
    expect(clampRect({ x: -4, y: 2, w: 1, h: 0 }, 12)).toEqual({ x: 0, y: 2, w: 2, h: 2 });
    expect(clampRect({ x: 45, y: 1, w: 30, h: 4 }, 48)).toEqual({ x: 18, y: 1, w: 30, h: 4 });
    expect(clampRect({ x: 5, y: 0, w: 99, h: 4 }, 48)).toEqual({ x: 0, y: 0, w: 48, h: 4 });
  });
  it('touching edges do not overlap', () => {
    expect(overlaps({ x: 0, y: 0, w: 6, h: 6 }, { x: 6, y: 0, w: 6, h: 6 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 7, h: 6 }, { x: 6, y: 0, w: 6, h: 6 })).toBe(true);
  });
});

describe.each([12, 48])('reflow on %i columns', (cols) => {
  const s = cols / 12;
  it('widening a panel pushes the neighbour below it, and nothing else moves', () => {
    const out = arrange(grid(cols), 'a', { x: 0, y: 0, w: 7 * s, h: 6 }, cols, true, 'resize');
    expect(out.a).toEqual({ x: 0, y: 0, w: 7 * s, h: 6 });
    expect(out.b.y).toBe(6);
    expect(out.c).toEqual(grid(cols).c);
    expect(out.d.y).toBe(12);
    expect(overlappingIds(out)).toEqual([]);
  });
  it('moving onto a panel pushes it down, never leaves an overlap', () => {
    const out = arrange(grid(cols), 'd', { x: 0, y: 0, w: 6 * s, h: 6 }, cols);
    expect(overlappingIds(out)).toEqual([]);
    expect(out.d.y).toBe(0);
    expect(out.a.y).toBe(6);
  });
  it('is deterministic and does not touch panels that do not collide', () => {
    const base = grid(cols);
    const one = arrange(base, 'b', { x: 6 * s, y: 2, w: 6 * s, h: 6 }, cols);
    expect(arrange(base, 'b', { x: 6 * s, y: 2, w: 6 * s, h: 6 }, cols)).toEqual(one);
    expect(one.a).toEqual(base.a);
    expect(one.c).toEqual(base.c);
  });
  it('a move that finds free space produces only that panel', () => {
    const out = arrange(grid(cols), 'a', { x: 0, y: 0, w: 6 * s, h: 6 }, cols);
    expect(out).toEqual(grid(cols));
  });
  it('resize stops at the right edge instead of sliding left', () => {
    const out = arrange(grid(cols), 'b', { x: 6 * s, y: 0, w: 20 * s, h: 6 }, cols, true, 'resize');
    expect(out.b.x).toBe(6 * s);
    expect(out.b.x + out.b.w).toBe(cols);
    expect(overlappingIds(out)).toEqual([]);
  });
  it('keyboard steps obey the same rule', () => {
    const next = keyStep(grid(cols).a, 'ArrowRight', true)!;
    const out = arrange(grid(cols), 'a', next, cols, true, 'resize');
    expect(out.a.w).toBe(6 * s + 1);
    expect(overlappingIds(out)).toEqual([]);
    const down = arrange(grid(cols), 'a', keyStep(grid(cols).a, 'ArrowDown', false)!, cols);
    expect(down.a.y).toBe(1);
    expect(overlappingIds(down)).toEqual([]);
    expect(keyStep(grid(cols).a, 'Enter', false)).toBeNull();
  });
  it('repairs an input layout that already overlaps', () => {
    const out = reflow({ a: { x: 0, y: 0, w: 6 * s, h: 4 }, b: { x: 0, y: 0, w: 6 * s, h: 4 }, c: { x: 0, y: 2, w: 6 * s, h: 4 } }, 'a', { x: 0, y: 0, w: 6 * s, h: 4 });
    expect(overlappingIds(out)).toEqual([]);
  });
  it('toolbar sizing reflows too, and is a no-op at the limits', () => {
    const wider = nudgeSize(grid(cols), 'a', 3, 0, cols);
    expect(wider.a.w).toBe(9 * s);
    expect(overlappingIds(wider)).toEqual([]);
    const full = nudgeSize({ a: { x: 0, y: 0, w: cols, h: 24 } }, 'a', 3, 2, cols);
    expect(full).toEqual({ a: { x: 0, y: 0, w: cols, h: 24 } });
  });
});

describe('ops', () => {
  const panels = [panel('a', 0, 0, 6, 6), panel('b', 6, 0, 6, 6), panel('c', 0, 6, 6, 6), panel('d', 6, 6, 6, 6)];
  it('lists exactly the changed panels, so the ops equal the final layout', () => {
    const next = arrange(grid(12), 'a', { x: 0, y: 0, w: 8, h: 6 }, 12, true, 'resize');
    const ops = diffOps(panels, next);
    expect(ops.map((o) => o.panelId)).toEqual(['a', 'b', 'd']);
    const applied: LayoutMap = Object.fromEntries(panels.map((p) => [p.panelId, p.layout]));
    for (const o of ops) applied[o.panelId] = o.layout;
    expect(applied).toEqual(next);
    expect(overlappingIds(applied)).toEqual([]);
  });
  it('produces nothing when nothing changed and keeps other layout fields', () => {
    expect(diffOps(panels, grid(12))).toEqual([]);
    const withExtra = [{ ...panels[0], layout: { ...panels[0].layout, z: 3 } as never }];
    expect(diffOps(withExtra, { a: { x: 1, y: 0, w: 6, h: 6 } })[0].layout).toEqual({ x: 1, y: 0, w: 6, h: 6, z: 3 });
  });
  it('swap settles collisions caused by different sizes', () => {
    const base: LayoutMap = { a: { x: 0, y: 0, w: 12, h: 4 }, b: { x: 0, y: 4, w: 6, h: 4 } };
    const out = swapSettled(base, [
      { op: 'movePanel', panelId: 'b', layout: { x: 0, y: 0, w: 6, h: 4 } },
      { op: 'movePanel', panelId: 'a', layout: { x: 0, y: 4, w: 12, h: 4 } },
    ], 12);
    expect(overlappingIds(out)).toEqual([]);
    expect(out.b.y).toBe(0);
  });
  it('picks 48 columns for wide layouts', () => {
    expect(columnsFor([{ x: 0, y: 0, w: 6, h: 6 }])).toBe(12);
    expect(columnsFor([{ x: 0, y: 0, w: 24, h: 6 }])).toBe(48);
    expect(columnsFor([{ x: 12, y: 0, w: 6, h: 6 }])).toBe(48);
  });
});
