'use client';

import { Button, Input, Select } from '@/components/nx/ui';
import type { Condition } from '@/lib/research/api';

export const MAX_DEPTH = 4;
export const MAX_NODES = 16;

export const emptyCompare = (metricId = ''): Condition => ({ kind: 'compare', metricId, op: 'gt', value: 0 });

export function shape(c: Condition): { depth: number; nodes: number } {
  if (c.kind === 'compare' || c.kind === 'zscore') return { depth: 1, nodes: 1 };
  const kids = c.kind === 'not' ? [c.term] : c.terms;
  const s = kids.map(shape);
  return { depth: 1 + Math.max(...s.map((x) => x.depth)), nodes: 1 + s.reduce((a, x) => a + x.nodes, 0) };
}

export function metricsIn(c: Condition): string[] {
  if (c.kind === 'compare' || c.kind === 'zscore') return c.metricId ? [c.metricId] : [];
  return Array.from(new Set((c.kind === 'not' ? [c.term] : c.terms).flatMap(metricsIn)));
}

export function describe(c: Condition): string {
  switch (c.kind) {
    case 'compare': {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', ne: '!=' }[c.op];
      return `${c.metricId} ${sym} ${c.value}`;
    }
    case 'zscore':
      return `|z(${c.metricId}, ${c.windowDays}d)| > ${c.absoluteGt}`;
    case 'not':
      return `not (${describe(c.term)})`;
    default:
      return c.terms.map((t) => `(${describe(t)})`).join(c.kind === 'and' ? ' and ' : ' or ');
  }
}

const KINDS = [
  { value: 'compare', label: 'Compare a metric to a value' },
  { value: 'zscore', label: 'Z-score outlier' },
  { value: 'and', label: 'All of (and)' },
  { value: 'or', label: 'Any of (or)' },
  { value: 'not', label: 'Not' },
];

/**
 * Recursive editor for the deterministic condition AST. There is no free-text expression: a rule is a tree of
 * compare, zscore, and, or, not, within depth 4 and 16 nodes (the API enforces the same limits).
 */
export function ConditionEditor({
  value,
  onChange,
  metrics,
  depth = 1,
  rootShape,
}: {
  value: Condition;
  onChange: (c: Condition) => void;
  metrics: string[];
  depth?: number;
  rootShape?: { depth: number; nodes: number };
}) {
  const sh = rootShape ?? shape(value);
  const setKind = (kind: string) => {
    const m = value.kind === 'compare' || value.kind === 'zscore' ? value.metricId : '';
    if (kind === 'compare') onChange(emptyCompare(m));
    else if (kind === 'zscore') onChange({ kind: 'zscore', metricId: m, windowDays: 14, absoluteGt: 3 });
    else if (kind === 'not') onChange({ kind: 'not', term: value.kind === 'and' || value.kind === 'or' ? value.terms[0]! : value });
    else onChange({ kind: kind as 'and' | 'or', terms: value.kind === 'and' || value.kind === 'or' ? value.terms : [value.kind === 'not' ? value.term : value, emptyCompare(m)] });
  };
  const canNest = depth < MAX_DEPTH && sh.nodes < MAX_NODES;

  return (
    <div className="col gap2" style={{ paddingLeft: depth > 1 ? 14 : 0, borderLeft: depth > 1 ? '2px solid var(--line-strong)' : undefined }} data-testid="condition-node" data-kind={value.kind}>
      <Select aria-label="Condition kind" value={value.kind} onChange={(e) => setKind(e.target.value)} options={KINDS} />
      {(value.kind === 'compare' || value.kind === 'zscore') && (
        <div className="row gap2" style={{ flexWrap: 'wrap' }}>
          <Input list="rule-metrics" aria-label="Metric id" placeholder="metric id, e.g. live.near_tx_count" value={value.metricId} onChange={(e) => onChange({ ...value, metricId: e.target.value })} style={{ minWidth: 240 }} />
          <datalist id="rule-metrics">{metrics.map((m) => <option key={m} value={m} />)}</datalist>
          {value.kind === 'compare' ? (
            <>
              <Select aria-label="Operator" value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as typeof value.op })} options={[{ value: 'gt', label: '>' }, { value: 'gte', label: '>=' }, { value: 'lt', label: '<' }, { value: 'lte', label: '<=' }, { value: 'eq', label: '=' }, { value: 'ne', label: '!=' }]} />
              <Input type="number" aria-label="Value" value={Number.isFinite(value.value) ? value.value : ''} onChange={(e) => onChange({ ...value, value: Number(e.target.value) })} style={{ width: 130 }} />
            </>
          ) : (
            <>
              <Input type="number" aria-label="Window days" title="Window (days, 2 to 365)" min={2} max={365} value={value.windowDays} onChange={(e) => onChange({ ...value, windowDays: Number(e.target.value) })} style={{ width: 100 }} />
              <Input type="number" aria-label="Absolute z greater than" title="|z| greater than" step="0.1" min={0.1} value={value.absoluteGt} onChange={(e) => onChange({ ...value, absoluteGt: Number(e.target.value) })} style={{ width: 100 }} />
            </>
          )}
        </div>
      )}
      {value.kind === 'not' && <ConditionEditor value={value.term} depth={depth + 1} metrics={metrics} rootShape={sh} onChange={(term) => onChange({ kind: 'not', term })} />}
      {(value.kind === 'and' || value.kind === 'or') && (
        <>
          {value.terms.map((t, i) => (
            <div key={i} className="col gap1">
              <ConditionEditor value={t} depth={depth + 1} metrics={metrics} rootShape={sh} onChange={(nt) => onChange({ ...value, terms: value.terms.map((x, j) => (j === i ? nt : x)) })} />
              {value.terms.length > 1 && (
                <div><Button variant="ghost" onClick={() => onChange({ ...value, terms: value.terms.filter((_, j) => j !== i) })}>Remove term</Button></div>
              )}
            </div>
          ))}
          <div>
            <Button variant="ghost" disabled={!canNest || value.terms.length >= 8} disabledReason={`A rule has at most ${MAX_NODES} nodes and ${MAX_DEPTH} levels.`} onClick={() => onChange({ ...value, terms: [...value.terms, emptyCompare()] })}>
              Add term
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
