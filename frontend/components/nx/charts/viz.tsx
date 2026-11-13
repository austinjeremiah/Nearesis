'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { validateViz, type PackColumn, type Row, type VizSpec } from '@/lib/viz/spec';
import { BlankChart, Chart, type ChartTheme } from '../chart';
import { Notice } from '../ui';
import { GraphCanvas, type GraphEdge, type GraphNode } from '../graph';
import { exact, num, optionFor, STATE_COLORS } from './options';

/**
 * One component renders every chart kind.
 *
 * It takes a validated Visualization IR and a typed result and draws whatever
 * the IR says, or refuses with a reason. There is no per-fixture component and
 * no per-panel special case, because the moment a chart needs hand-written JSX
 * it stops being reproducible from the record.
 */

export function VizRender({
  spec,
  columns,
  rows,
  height = 240,
  ariaLabel,
  onBrushEnd,
  onConvert,
}: {
  spec: VizSpec;
  columns: PackColumn[];
  rows: Row[];
  height?: number;
  ariaLabel: string;
  onBrushEnd?: (range: { start: string; end: string }) => void;
  /** Offered when the validator rejects the chart but a legal kind exists. */
  onConvert?: (kind: VizSpec['kind']) => void;
}) {
  const verdict = useMemo(() => validateViz(spec, columns, rows), [spec, columns, rows]);

  const option = useCallback(
    (t: ChartTheme) => optionFor(spec, columns, rows, t) ?? {},
    [spec, columns, rows],
  );

  if (!verdict.ok) {
    return (
      <div className="col gap3">
        <Notice tone="bad" title="This chart was refused">
          {verdict.reason}
        </Notice>
        {verdict.remedy && onConvert && (
          <button type="button" className="btn" onClick={() => onConvert(verdict.remedy!.kind)}>
            {verdict.remedy.label}
          </button>
        )}
        <BlankChart
          height={height - 40}
          reason="Nothing is drawn while the specification is invalid."
          ariaLabel={ariaLabel}
        />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <BlankChart
        height={height}
        reason="No source observations for this interval. The axes are kept and nothing is drawn."
        ariaLabel={ariaLabel}
      />
    );
  }

  if (spec.kind === 'table') return <VizTable spec={spec} columns={columns} rows={rows} height={height} />;
  if (spec.kind === 'evidence_graph') return <VizGraph rows={rows} height={height} />;
  if (spec.kind === 'agent_timeline') return <VizTimeline rows={rows} height={height} />;

  return <Chart option={option} height={height} ariaLabel={ariaLabel} onBrushEnd={onBrushEnd} />;
}

/* ---------------------------------------------------------------------------
   table
   ------------------------------------------------------------------------ */

/**
 * Exact values. A decimal that arrived as a string leaves as the same string:
 * no parse, no reformat, no rounding. An unavailable cell is an em dash and is
 * never shown as zero.
 */
function VizTable({
  spec,
  columns,
  rows,
  height,
}: {
  spec: VizSpec;
  columns: PackColumn[];
  rows: Row[];
  height: number;
}) {
  const declared = Array.isArray(spec.encodings?.columns)
    ? (spec.encodings.columns as string[])
    : null;
  const keys = declared ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];

  return (
    <div className="table-wrap" style={{ maxHeight: height, overflowY: 'auto' }}>
      <table className="table" data-density="compact">
        <thead>
          <tr>
            {keys.map((k) => {
              const c = columns.find((cc) => cc.id === k);
              return (
                <th key={k} title={c?.unit}>
                  {k}
                  {c?.unit && <span className="tiny dim"> · {c.unit}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r.id ?? r.quoteId ?? i)}>
              {keys.map((k) => {
                const v = r[k];
                const unavailable = v === null || v === undefined;
                return (
                  <td key={k} className="mono">
                    {unavailable ? (
                      <span className="unavailable" title="Unavailable, not zero" />
                    ) : (
                      exact(v)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   evidence graph
   ------------------------------------------------------------------------ */

const NODE_COLUMN: Record<string, number> = {
  hypothesis: 0,
  claim: 0,
  observation: 1,
  result: 1,
  query: 2,
  source: 3,
  snapshot: 3,
};

const ALLOWED_RELATIONS = [
  'supports',
  'contradicts',
  'derived_from',
  'monitors',
  'references',
  'reproduces',
  'supersedes',
];

type PackGraphNode = { id: string; type: string; label: string };
type PackGraphEdge = { from: string; to: string; relation: string };

/**
 * The pack carries the graph inside one row as typed nodes and edges. Only the
 * seven declared relations are drawn; anything else is reported rather than
 * invented into a line on the canvas.
 */
function VizGraph({ rows, height }: { rows: Row[]; height: number }) {
  const payload = rows[0] ?? {};
  const rawNodes = (payload.nodes as PackGraphNode[] | undefined) ?? [];
  const rawEdges = (payload.edges as PackGraphEdge[] | undefined) ?? [];

  const rejected = rawEdges.filter((e) => !ALLOWED_RELATIONS.includes(e.relation));
  const edges: GraphEdge[] = rawEdges
    .filter((e) => ALLOWED_RELATIONS.includes(e.relation))
    .map((e) => ({ from: e.from, to: e.to }));

  const perColumn = new Map<number, number>();
  const nodes: GraphNode[] = rawNodes.map((n) => {
    const colIndex = NODE_COLUMN[n.type] ?? 2;
    const row = perColumn.get(colIndex) ?? 0;
    perColumn.set(colIndex, row + 1);
    return {
      id: n.id,
      kind: (n.type === 'hypothesis' || n.type === 'claim'
        ? 'claim'
        : n.type === 'source' || n.type === 'snapshot'
          ? 'snapshot'
          : 'result') as GraphNode['kind'],
      label: n.type,
      title: n.label,
      mono: n.id,
      x: colIndex * 272,
      y: row * 140,
      detail: [
        { k: 'Node id', v: <span className="mono">{n.id}</span> },
        { k: 'Type', v: n.type },
      ],
      note: 'Synthetic fixture node. No source URL is invented for it.',
    };
  });

  return (
    <div className="col gap2">
      {rejected.length > 0 && (
        <Notice tone="warn" title="Unsupported relation dropped">
          {rejected.length} edge(s) use a relation outside the seven the schema allows, and are not
          drawn.
        </Notice>
      )}
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        height={height}
        renderLink={(l) => (
          <Link className="link small" href={l.href}>
            {l.label}
          </Link>
        )}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   agent timeline
   ------------------------------------------------------------------------ */

const TASK_TONE: Record<string, string> = {
  complete: 'ok',
  running: 'info',
  blocked: 'bad',
  queued: '',
  failed: 'bad',
};

/**
 * Durable task records only. A task with no end time is unfinished, which is
 * not the same as complete, and nothing here shows a model's reasoning.
 */
function VizTimeline({ rows, height }: { rows: Row[]; height: number }) {
  const times = rows
    .flatMap((r) => [r.startedAt, r.endedAt])
    .map((v) => (typeof v === 'string' ? Date.parse(v) : NaN))
    .filter((n) => Number.isFinite(n));
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(1, max - min);

  return (
    <div className="col gap2" style={{ maxHeight: height, overflowY: 'auto' }}>
      {rows.map((r, i) => {
        const start = typeof r.startedAt === 'string' ? Date.parse(r.startedAt) : NaN;
        const end = typeof r.endedAt === 'string' ? Date.parse(r.endedAt) : NaN;
        const open = !Number.isFinite(end);
        const left = Number.isFinite(start) ? ((start - min) / span) * 100 : 0;
        const width = open ? 100 - left : Math.max(2, ((end - start) / span) * 100);
        const status = exact(r.status);
        return (
          <div key={String(r.taskId ?? i)} className="col gap1">
            <div className="row gap2 wrap">
              <span className="small strong">{exact(r.role)}</span>
              <span className={`badge ${TASK_TONE[status] ?? ''}`}>{status}</span>
              {open && <span className="tiny dim">no end time recorded, not finished</span>}
              {r.resultId !== undefined && r.resultId !== null && (
                <span className="tiny dim mono">{exact(r.resultId)}</span>
              )}
            </div>
            <div className="timeline-track" aria-hidden="true">
              <span
                className="timeline-bar"
                data-open={open ? 'true' : 'false'}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Legend for the categorical coverage states, used beside calendar heatmaps. */
export function StateLegend({ states }: { states: string[] }) {
  return (
    <div className="row gap3 wrap tiny dim">
      {states.map((s) => (
        <span key={s} className="row gap1" style={{ alignItems: 'center' }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 2,
              background: STATE_COLORS[s] ?? 'var(--text-3)',
              display: 'inline-block',
            }}
          />
          {s.replace(/_/g, ' ')}
        </span>
      ))}
    </div>
  );
}

/** Row count helper used by panel headers: how many pairs actually plot. */
export function plottablePairs(rows: Row[], x: string, y: string): number {
  return rows.filter((r) => num(r[x]) !== null && num(r[y]) !== null).length;
}
