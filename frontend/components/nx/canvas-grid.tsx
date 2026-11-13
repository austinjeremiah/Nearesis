'use client';

import {
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
}: {
  /** Draw order. A panel without a rect is placed at the end of the stack. */
  ids: string[];
  layout: LayoutMap;
  /** Called continuously while dragging, so the move is visible as it happens. */
  onLayoutChange: (next: LayoutMap) => void;
  /** Called once when a gesture ends, which is the point a revision is saved. */
  onCommit?: (next: LayoutMap) => void;
  renderItem: (id: string) => ReactNode;
  columns?: number;
  rowHeight?: number;
  gap?: number;
  snap?: boolean;
  showGrid?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  locked?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1200);
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
            {renderItem(id)}
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

/* ---------------------------------------------------------------------------
   layout history
   ------------------------------------------------------------------------ */

/**
 * Undo and redo over layout only.
 *
 * Spec 6.5 keeps document revisions and data revisions apart: undoing a move
 * must never re-run a query or roll back a result. This hook therefore holds
 * nothing but geometry, and the revision it counts is the document's.
 */
export function useLayoutHistory(initial: LayoutMap, storageKey?: string) {
  const [present, setPresent] = useState<LayoutMap>(initial);
  const past = useRef<LayoutMap[]>([]);
  const future = useRef<LayoutMap[]>([]);
  const [revision, setRevision] = useState(1);
  const [, force] = useState(0);

  // Read the saved layout after mount so the server and client first paint match.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as { layout: LayoutMap; revision: number };
      if (saved?.layout) {
        setPresent(saved.layout);
        setRevision(saved.revision ?? 1);
      }
    } catch {
      /* blocked storage is not an error: the default layout stands */
    }
  }, [storageKey]);

  const persist = useCallback(
    (next: LayoutMap, rev: number) => {
      if (!storageKey) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify({ layout: next, revision: rev }));
      } catch {
        /* non-fatal */
      }
    },
    [storageKey],
  );

  /** Live update during a gesture. Not a history entry on its own. */
  const set = useCallback((next: LayoutMap) => setPresent(next), []);

  /** End of a gesture: this is the point that becomes undoable. */
  const commit = useCallback(
    (next: LayoutMap) => {
      past.current = [...past.current.slice(-49), present];
      future.current = [];
      setPresent(next);
      setRevision((r) => {
        persist(next, r + 1);
        return r + 1;
      });
      force((n) => n + 1);
    },
    [present, persist],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(present);
    setPresent(prev);
    setRevision((r) => {
      persist(prev, r + 1);
      return r + 1;
    });
    force((n) => n + 1);
  }, [present, persist]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(present);
    setPresent(next);
    setRevision((r) => {
      persist(next, r + 1);
      return r + 1;
    });
    force((n) => n + 1);
  }, [present, persist]);

  const reset = useCallback(
    (to: LayoutMap) => {
      past.current = [...past.current.slice(-49), present];
      future.current = [];
      setPresent(to);
      setRevision((r) => {
        persist(to, r + 1);
        return r + 1;
      });
      force((n) => n + 1);
    },
    [present, persist],
  );

  return {
    layout: present,
    set,
    commit,
    undo,
    redo,
    reset,
    revision,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
