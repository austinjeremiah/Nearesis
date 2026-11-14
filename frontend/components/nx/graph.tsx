'use client';

import './research.css';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Crosshair, Maximize2, Minus, Plus, X } from 'lucide-react';

/**
 * A pannable, zoomable graph surface.
 *
 * The evidence chain is a graph, and a static row of boxes forces the reader to
 * take the layout on trust. Here the same records are nodes on a canvas the
 * reader can drag, zoom and rearrange, so following a claim down to its raw
 * snapshot is something you do with your hands rather than something you read.
 *
 * Deliberately hand-written rather than pulled from a flow library: the graph is
 * a few dozen nodes with a fixed geometry, and the whole interaction is pan,
 * zoom, drag and select. A library would add a dependency and its own styling
 * conventions for behaviour that is this short.
 *
 * Every node is a real button, so the graph is reachable by keyboard, and the
 * page keeps a plain list view alongside it for anyone who wants the records
 * without the canvas.
 */

export const GRAPH_NODE_W = 216;
export const GRAPH_NODE_H = 92;

const MIN_K = 0.25;
const MAX_K = 2.2;
/* A chain six columns wide does not fit a laptop at a readable size. Rather
   than shrink the type to nothing, the opening view never goes below this and
   the reader pans, the way they would on any canvas. */
const FIT_MIN = 0.72;

export type GraphNode = {
  id: string;
  /** Rendered as the node's eyebrow and used for the colour key. */
  kind: string;
  label: string;
  title: string;
  /** Hash, id or version line, set in the mono face. */
  mono?: string;
  x: number;
  y: number;
  detail?: { k: string; v: ReactNode }[];
  note?: string;
  link?: { label: string; href: string };
  /** A short state tag shown on the node (for example unsupported, recheck, tombstone). */
  tag?: { label: string; tone: 'ok' | 'warn' | 'bad' };
};

export type GraphEdge = { from: string; to: string; label?: string };

type View = { x: number; y: number; k: number };
type Point = { x: number; y: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function GraphCanvas({
  nodes,
  edges,
  height = 620,
  renderLink,
  onSelect,
  onPositions,
  renderDetail,
  selectId,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  height?: number;
  /** The page supplies its own router link so this file stays routing-agnostic. */
  renderLink?: (link: { label: string; href: string }) => ReactNode;
  /** Fired when the selected node changes (null when cleared). */
  onSelect?: (id: string | null) => void;
  /** Fired when a drag ends, with every node's current position. Dragging never changes the evidence, only the layout. */
  onPositions?: (positions: Record<string, { x: number; y: number }>) => void;
  /** Replaces the built-in detail card body for the selected node. */
  renderDetail?: (node: GraphNode) => ReactNode;
  /** Select a node from outside (a neighbour link in the detail card). */
  selectId?: string | null;
}) {
  const [pos, setPos] = useState<Record<string, Point>>(() =>
    Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }])),
  );
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [selected, setSelectedRaw] = useState<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const setSelected = useCallback((id: string | null) => {
    setSelectedRaw(id);
    onSelectRef.current?.(id);
  }, []);
  useEffect(() => {
    if (selectId !== undefined) setSelected(selectId);
  }, [selectId, setSelected]);
  const [panning, setPanning] = useState(false);

  const vp = useRef<HTMLDivElement | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const kRef = useRef(view.k);
  kRef.current = view.k;
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  /** Set the moment the reader pans, zooms or drags, so an automatic refit
      never yanks the canvas out from under them. */
  const touched = useRef(false);

  const onPositionsRef = useRef(onPositions);
  onPositionsRef.current = onPositions;
  const dragEnd = useCallback(() => onPositionsRef.current?.(posRef.current), []);

  /* New nodes (a filter toggled, a refetch) get their computed position; nodes already moved keep theirs. */
  useEffect(() => {
    setPos((p) => {
      let changed = false;
      const next = { ...p };
      for (const n of nodes) if (!next[n.id]) { next[n.id] = { x: n.x, y: n.y }; changed = true; }
      return changed ? next : p;
    });
  }, [nodes]);

  const move = useCallback((id: string, x: number, y: number) => {
    touched.current = true;
    setPos((p) => ({ ...p, [id]: { x, y } }));
  }, []);

  /** Frame the whole graph in the viewport, which is also the reset. */
  const fit = useCallback(() => {
    const el = vp.current;
    const all = Object.values(posRef.current);
    if (!el || all.length === 0) return;
    const rect = el.getBoundingClientRect();
    const minX = Math.min(...all.map((p) => p.x));
    const minY = Math.min(...all.map((p) => p.y));
    const maxX = Math.max(...all.map((p) => p.x)) + GRAPH_NODE_W;
    const maxY = Math.max(...all.map((p) => p.y)) + GRAPH_NODE_H;
    const pad = 44;
    const k = clamp(
      Math.min((rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)),
      FIT_MIN,
      1,
    );
    const cw = (maxX - minX) * k;
    const ch = (maxY - minY) * k;
    touched.current = false;
    setView({
      k,
      // Centred when it fits; pinned to the start of the chain when it does not,
      // because the reader's eye starts at the hypothesis, not in the middle.
      x: cw <= rect.width - pad * 2 ? (rect.width - cw) / 2 - minX * k : pad - minX * k,
      y: ch <= rect.height - pad * 2 ? (rect.height - ch) / 2 - minY * k : pad - minY * k,
    });
  }, []);

  /*
    Frame the graph whenever the viewport settles on a new size, until the
    reader takes over. Measuring only once on mount read the column before the
    layout had settled and left the graph framed for a narrower canvas.
  */
  useLayoutEffect(() => {
    const el = vp.current;
    if (!el) return;
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!touched.current) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  /**
   * Wheel zoom around the cursor. Registered by hand because it has to call
   * preventDefault, and React's synthetic wheel listener is passive.
   */
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const k = clamp(v.k * Math.exp(-e.deltaY * 0.0016), MIN_K, MAX_K);
        const r = k / v.k;
        return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /** Zoom by a step, holding the centre of the viewport still. */
  const zoomBy = (factor: number) => {
    touched.current = true;
    const el = vp.current;
    const rect = el?.getBoundingClientRect();
    const px = (rect?.width ?? 0) / 2;
    const py = (rect?.height ?? 0) / 2;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const r = k / v.k;
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
    });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.gnode, .graph-controls, .graph-detail')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    touched.current = true;
    setPanning(true);
    setSelected(null);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  const endPan = () => {
    pan.current = null;
    setPanning(false);
  };

  const active = selected ? nodes.find((n) => n.id === selected) : null;

  return (
    <div
      ref={vp}
      className="graph"
      data-panning={panning ? 'true' : 'false'}
      style={{
        ['--graph-h' as string]: `${height}px`,
        backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      role="group"
      aria-label="Evidence graph. Drag to pan, scroll to zoom, and select a node for its record. The same records are listed in the List tab."
    >
      <div
        className="graph-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="graph-edges" width="1" height="1" aria-hidden="true">
          {edges.map((e) => {
            const a = pos[e.from];
            const b = pos[e.to];
            if (!a || !b) return null;
            const x1 = a.x + GRAPH_NODE_W;
            const y1 = a.y + GRAPH_NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + GRAPH_NODE_H / 2;
            const c = Math.max(40, (x2 - x1) / 2);
            const hot = selected === e.from || selected === e.to;
            return (
              <g key={`${e.from}-${e.to}`}>
                <path
                  className={hot ? 'hot' : undefined}
                  d={`M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`}
                />
                <circle cx={x2} cy={y2} r={3} className={hot ? 'hot' : undefined} />
              </g>
            );
          })}
        </svg>

        {nodes.map((n) => (
          <GraphNodeView
            key={n.id}
            node={n}
            at={pos[n.id]}
            selected={selected === n.id}
            scale={kRef}
            onMove={move}
            onDragEnd={dragEnd}
            onSelect={setSelected}
          />
        ))}
      </div>

      <div className="graph-controls">
        <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
          <Minus size={15} />
        </button>
        <span className="zoom" aria-live="off">
          {Math.round(view.k * 100)}%
        </span>
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          <Plus size={15} />
        </button>
        <button type="button" onClick={fit} aria-label="Fit the graph to the view">
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            setPos(Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }])));
            setTimeout(fit, 0);
          }}
          aria-label="Reset the layout"
        >
          <Crosshair size={14} />
        </button>
      </div>

      {!active && <div className="graph-hint">Drag to pan · scroll to zoom · click a node</div>}

      {active && (
        <aside className="graph-detail" aria-label={`${active.label} detail`}>
          <div className="card-head" style={{ padding: '12px 14px' }}>
            <div className="grow">
              <span className="label">{active.label}</span>
              <div className="small strong">{active.title}</div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Close detail"
              className="btn icon ghost"
            >
              <X size={14} />
            </button>
          </div>
          <div className="card-body" style={{ padding: '12px 14px', gap: 12 }}>
            {renderDetail ? renderDetail(active) : null}
            {!renderDetail && active.mono && <div className="small mono">{active.mono}</div>}
            {!renderDetail && active.detail && active.detail.length > 0 && (
              <dl style={{ margin: 0 }}>
                {active.detail.map((d) => (
                  <div className="kv" key={d.k}>
                    <dt>{d.k}</dt>
                    <dd>{d.v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {!renderDetail && active.note && <p className="tiny dim">{active.note}</p>}
            {!renderDetail && active.link && renderLink && renderLink(active.link)}
          </div>
        </aside>
      )}
    </div>
  );
}

function GraphNodeView({
  node,
  at,
  selected,
  scale,
  onMove,
  onDragEnd,
  onSelect,
}: {
  node: GraphNode;
  at: Point | undefined;
  selected: boolean;
  scale: { current: number };
  onMove: (id: string, x: number, y: number) => void;
  onDragEnd: () => void;
  onSelect: (id: string) => void;
}) {
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // A drag that ends on the node would otherwise also fire a click and open the
  // detail panel, so a moved pointer swallows the next click.
  const moved = useRef(false);
  const p = at ?? { x: node.x, y: node.y };

  return (
    <button
      type="button"
      className="gnode"
      data-kind={node.kind}
      data-selected={selected ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      style={{ left: p.x, top: p.y }}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
        moved.current = false;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const k = scale.current || 1;
        const dx = (e.clientX - d.sx) / k;
        const dy = (e.clientY - d.sy) / k;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved.current = true;
        onMove(node.id, d.ox + dx, d.oy + dy);
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
        if (moved.current) onDragEnd();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      data-node-id={node.id}
      data-tone={node.tag?.tone}
      onClick={() => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onSelect(node.id);
      }}
    >
      <span className="k">
        {node.label}
        {node.tag && <span className={`gtag ${node.tag.tone}`}>{node.tag.label}</span>}
      </span>
      <span className="t">{node.title}</span>
      {node.mono && <span className="s">{node.mono}</span>}
    </button>
  );
}
