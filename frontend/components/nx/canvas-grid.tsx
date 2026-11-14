'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

/**
 * The Canvas layout surface.
 *
 * Spec 5.7: "snap to responsive grid; drag/resize panels with keyboard
 * alternative; deterministic panel IDs; save layout via expected revision."
 * This component owns geometry and input only. It never touches panel data, so
 * moving a panel cannot change a number, and a data refresh cannot move a panel.
 *
 * Two modes. Grid snaps every edge to the twelve column track, which is what
 * keeps a dashboard readable. Freeform keeps the same coordinate space but
 * stops rounding, for the rare panel that needs to sit off the track.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type LayoutMap = Record<string, Rect>;

const MIN_W = 2;
const MIN_H = 2;

type DragState = {
  pointerId: number;
  id: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  origin: Rect;
  moved: boolean;
};

export function CanvasGrid({
  ids,
  layout,
  onLayoutChange,
  onCommit,
  renderItem,
  columns = 12,
  rowHeight = 56,
  gap = 16,
  snap = true,
  showGrid = false,
  selectedId,
  onSelect,
  locked = false,
  freeze = false,
}: {
  /** Draw order. A panel without a rect is placed at the end of the stack. */
  ids: string[];
  layout: LayoutMap;
  /** Called continuously while dragging, so the move is visible as it happens. */
  onLayoutChange: (next: LayoutMap) => void;
  /** Called once when a gesture ends, which is the point a revision is saved. */
  onCommit?: (next: LayoutMap) => void;
  /** Receives the panel's rect so a cell can size its chart without reading
      the whole layout, which keeps one panel's move from re-rendering all of
      the others. */
  renderItem: (id: string, rect: Rect) => ReactNode;
  columns?: number;
  rowHeight?: number;
  gap?: number;
  snap?: boolean;
  showGrid?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  locked?: boolean;
  /**
   * Hold the measured width still. While the surrounding layout is animating,
   * re-measuring on every frame would re-render every panel and resize every
   * chart canvas sixty times a second, which is what makes a smooth CSS
   * transition look like a stutter.
   */
  freeze?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1200);
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const frozen = useRef(freeze);
  frozen.current = freeze;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (frozen.current) return;
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One measurement when the surrounding animation finishes.
  useEffect(() => {
    if (freeze) return;
    const el = host.current;
    if (el) setWidth(el.clientWidth);
  }, [freeze]);

  const colW = Math.max(40, (width - gap * (columns - 1)) / columns);
  const unitX = colW + gap;
  const unitY = rowHeight + gap;

  const place = useCallback(
    (r: Rect) => ({
      left: r.x * unitX,
      top: r.y * unitY,
      width: Math.max(colW, r.w * colW + (r.w - 1) * gap),
      height: Math.max(rowHeight, r.h * rowHeight + (r.h - 1) * gap),
    }),
    [unitX, unitY, colW, gap, rowHeight],
  );

  const fallback = useCallback(
    (index: number): Rect => ({ x: (index % 2) * 6, y: Math.floor(index / 2) * 6, w: 6, h: 6 }),
    [],
  );

  const rectOf = (id: string, index: number): Rect => layout[id] ?? fallback(index);

  const clamp = useCallback(
    (r: Rect): Rect => {
      const round = (n: number) => (snap ? Math.round(n) : Math.round(n * 100) / 100);
      const w = Math.max(MIN_W, Math.min(columns, round(r.w)));
      const h = Math.max(MIN_H, round(r.h));
      return {
        w,
        h,
        x: Math.max(0, Math.min(columns - w, round(r.x))),
        y: Math.max(0, round(r.y)),
      };
    },
    [columns, snap],
  );

  /* --- pointer ------------------------------------------------------------ */

  const begin = (e: ReactPointerEvent<HTMLDivElement>, id: string, mode: 'move' | 'resize', index: number) => {
    if (locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origin: rectOf(id, index),
      moved: false,
    };
    setDragging(id);
    onSelect?.(id);
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = (e.clientX - d.startX) / unitX;
    const dy = (e.clientY - d.startY) / unitY;
    if (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3) d.moved = true;
    const next: Rect =
      d.mode === 'move'
        ? { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy }
        : { ...d.origin, w: d.origin.w + dx, h: d.origin.h + dy };
    onLayoutChange({ ...layoutRef.current, [d.id]: clamp(next) });
  };

  const end = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d?.moved) onCommit?.(layoutRef.current);
  };

  /* --- keyboard ----------------------------------------------------------- */

  /**
   * The accessible equivalent of dragging. Arrows move by one track, shift with
   * arrows resizes, and the change commits on key up like a finished gesture.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, id: string, index: number) => {
    if (locked) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const r = rectOf(id, index);
    const step = e.shiftKey ? 'resize' : 'move';
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ] as [number, number];
    const next =
      step === 'move'
        ? { ...r, x: r.x + delta[0], y: r.y + delta[1] }
        : { ...r, w: r.w + delta[0], h: r.h + delta[1] };
    const committed = { ...layoutRef.current, [id]: clamp(next) };
    onLayoutChange(committed);
    onCommit?.(committed);
  };

  const bottom = Math.max(
    6,
    ...ids.map((id, i) => {
      const r = rectOf(id, i);
      return r.y + r.h;
    }),
  );

  return (
    <div
      ref={host}
      className="cgrid"
      data-grid={showGrid ? 'true' : 'false'}
      data-locked={locked ? 'true' : 'false'}
      style={{
        height: bottom * unitY,
        ['--cgrid-col' as string]: `${unitX}px`,
        ['--cgrid-row' as string]: `${unitY}px`,
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {ids.map((id, index) => {
        const r = rectOf(id, index);
        const box = place(r);
        const isSelected = selectedId === id;
        return (
          <div
            key={id}
            className="cgrid-item"
            data-dragging={dragging === id ? 'true' : 'false'}
            data-selected={isSelected ? 'true' : 'false'}
            style={{ transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height }}
            tabIndex={0}
            role="group"
            aria-label={`Panel ${id}. Arrow keys move it, shift with arrow keys resizes it.`}
            onKeyDown={(e) => onKeyDown(e, id, index)}
            onFocus={() => onSelect?.(id)}
            onPointerDown={(e) => {
              // Anything interactive keeps its own behaviour: only empty chrome
              // starts a drag, so a reader can still brush a chart or use a menu.
              const t = e.target as HTMLElement;
              if (t.closest('button, a, input, select, textarea, .chart, canvas, .table-wrap, .graph')) return;
              begin(e, id, 'move', index);
            }}
          >
            <GridCell id={id} rect={r} render={renderItem} />
            {!locked && (
              <span
                className="cgrid-resize"
                role="presentation"
                aria-hidden="true"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  begin(e as unknown as ReactPointerEvent<HTMLDivElement>, id, 'resize', index);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The expensive half of a panel, held behind a memo.
 *
 * Without this, selecting a panel or opening the inspector re-rendered every
 * panel on the canvas, charts included: 25 ECharts instances rebuilding inside
 * a 240ms transition, which is exactly the stutter it looked like. The cell
 * re-renders only when its own id or geometry changes.
 */
const GridCell = memo(
  function GridCell({
    id,
    rect,
    render,
  }: {
    id: string;
    rect: Rect;
    render: (id: string, rect: Rect) => ReactNode;
  }) {
    return <>{render(id, rect)}</>;
  },
  (a, b) =>
    a.id === b.id &&
    a.render === b.render &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.w === b.rect.w &&
    a.rect.h === b.rect.h,
);
