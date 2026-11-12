'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, Notice, Tabs, Textarea } from '@/components/nx/ui';
import { DataTable, type Column } from '@/components/nx/table';
import { GraphCanvas, GRAPH_NODE_H, GRAPH_NODE_W, type GraphEdge as VEdge, type GraphNode as VNode } from '@/components/nx/graph';
import { MutationError, Slot, SUPPORT_TONE } from '@/components/nx/research-kit';
import { research, rk, type GraphNode, type GraphProjection } from '@/lib/research/api';
import { formatUtc, shortHash } from '@/lib/format';
import { browserApi } from '@/lib/api/browser';

/** Column of each node kind, so a claim reads left to right down to its query and source. */
const COLUMN: Record<string, number> = {
  hypothesis: 0,
  claim: 1,
  statistical_result: 2,
  model: 2,
  observation: 2,
  verification_artifact: 2,
  marker: 3,
  query: 3,
  source: 4,
  agent: 5,
};
const KIND_LABEL: Record<string, string> = {
  statistical_result: 'statistical result',
  verification_artifact: 'verification',
};
const ROWS_PER_COLUMN = 9;

export function layoutNodes(nodes: GraphNode[]): VNode[] {
  const buckets = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const c = COLUMN[n.type] ?? 4;
    buckets.set(c, [...(buckets.get(c) ?? []), n]);
  }
  const out: VNode[] = [];
  let xBase = 0;
  for (const c of [...buckets.keys()].sort((a, b) => a - b)) {
    const list = buckets.get(c)!;
    const subCols = Math.ceil(list.length / ROWS_PER_COLUMN);
    list.forEach((n, i) => {
      const sub = Math.floor(i / ROWS_PER_COLUMN);
      const row = i % ROWS_PER_COLUMN;
      const tag = n.tombstone
        ? { label: 'tombstone', tone: 'bad' as const }
        : n.recheckRequired
          ? { label: 'recheck', tone: 'warn' as const }
          : n.type === 'claim' && n.support
            ? { label: n.support, tone: SUPPORT_TONE[n.support] ?? ('warn' as const) }
            : undefined;
      out.push({
        id: n.id,
        kind: n.type,
        label: KIND_LABEL[n.type] ?? n.type,
        title: n.label,
        mono: n.queryRef ? shortHash(n.queryRef, 10, 4) : n.id.slice(0, 8),
        x: n.position?.x ?? xBase + sub * (GRAPH_NODE_W + 40),
        y: n.position?.y ?? row * (GRAPH_NODE_H + 24),
        tag,
      });
    });
    xBase += subCols * (GRAPH_NODE_W + 40) + 60;
  }
  return out;
}

type TabKey = 'graph' | 'list' | 'rechecks' | 'impact';

export default function EvidenceView({ wid }: { wid: string }) {
  const [tab, setTab] = useState<TabKey>('graph');
  const q = useQuery({ queryKey: rk.graph(wid), queryFn: () => research.graph(wid) });
  const rechecks = useQuery({ queryKey: rk.rechecks(wid), queryFn: () => research.rechecks(wid) });
  const nodeCount = q.data?.nodes.length ?? 0;

  return (
    <>
      <PageHeader
        title="Evidence graph"
        description="Claims, the queries and results behind them, and what is missing. Dragging a node saves the layout only; it never changes the evidence."
        context={q.data ? <Badge outline>graph v{q.data.version}</Badge> : undefined}
      />
      <Content>
        <div className="col gap3">
          <Tabs
            ariaLabel="Evidence views"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'graph', label: 'Graph' },
              { value: 'list', label: `List${q.data ? ` (${nodeCount})` : ''}` },
              { value: 'rechecks', label: `Rechecks${rechecks.data ? ` (${rechecks.data.flags.length})` : ''}` },
              { value: 'impact', label: 'Impact' },
            ]}
          />
          <Slot q={q} rows={6}>
            {(g) =>
              tab === 'graph' ? (
                <GraphTab wid={wid} g={g} />
              ) : tab === 'list' ? (
                <ListTab wid={wid} g={g} />
              ) : tab === 'rechecks' ? (
                <RechecksTab wid={wid} g={g} />
              ) : (
                <ImpactTab wid={wid} />
              )
            }
          </Slot>
        </div>
      </Content>
    </>
  );
}

/* ----------------------------------------------------------------- graph tab */
function GraphTab({ wid, g }: { wid: string; g: GraphProjection }) {
  const qc = useQueryClient();
  const [showAgents, setShowAgents] = useState(false);
  const [dirty, setDirty] = useState<Record<string, { x: number; y: number }> | null>(null);
  const [selectId, setSelectId] = useState<string | null>(null);

  const visible = useMemo(() => g.nodes.filter((n) => showAgents || n.type !== 'agent'), [g.nodes, showAgents]);
  const ids = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const vnodes = useMemo(() => layoutNodes(visible), [visible]);
  const vedges: VEdge[] = useMemo(
    () => g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ from: e.source, to: e.target, label: e.relation })),
    [g.edges, ids],
  );
  const byId = useMemo(() => new Map(g.nodes.map((n) => [n.id, n])), [g.nodes]);

  const save = useMutation({
    mutationFn: () => research.saveLayout(wid, dirty!),
    onSuccess: () => {
      setDirty(null);
      void qc.invalidateQueries({ queryKey: rk.graph(wid) });
    },
  });

  if (g.nodes.length === 0)
    return <EmptyState title="The evidence graph is empty" body="Claims, queries and results appear here once an investigation has produced them." />;

  return (
    <div className="col gap3" data-testid="evidence-graph" data-node-count={g.nodes.length} data-edge-count={g.edges.length}>
      <div className="row gap3" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="row gap2 small">
          <input type="checkbox" checked={showAgents} onChange={(e) => setShowAgents(e.target.checked)} data-testid="toggle-agents" />
          Show agent nodes ({g.nodes.filter((n) => n.type === 'agent').length})
        </label>
        <span className="small dim">
          {visible.length} nodes, {vedges.length} edges shown
        </span>
        <div className="grow" />
        {dirty && <Badge tone="warn">layout changed</Badge>}
        <Button
          variant="primary"
          disabled={!dirty}
          disabledReason="Drag a node first."
          pending={save.isPending}
          onClick={() => save.mutate()}
          data-testid="save-layout"
        >
          Save layout
        </Button>
      </div>
      <MutationError error={save.error} />
      {g.unresolved.length > 0 && (
        <Notice tone="warn" title={`${g.unresolved.length} edge(s) point at nodes that no longer exist`}>
          They are left out of the graph rather than drawn to nowhere.
        </Notice>
      )}
      <GraphCanvas
        nodes={vnodes}
        edges={vedges}
        height={640}
        selectId={selectId}
        onSelect={setSelectId}
        onPositions={(p) => setDirty(p)}
        renderDetail={(n) => <NodeInspector wid={wid} node={byId.get(n.id)!} g={g} onFocus={setSelectId} />}
      />
    </div>
  );
}

/* ------------------------------------------------------------ node inspector */
export function NodeInspector({ wid, node, g, onFocus }: { wid: string; node: GraphNode; g: GraphProjection; onFocus?: (id: string) => void }) {
  const deref = useQuery({ queryKey: rk.evidence(wid, node.id), queryFn: () => research.evidence(wid, node.id) });
  const byId = useMemo(() => new Map(g.nodes.map((n) => [n.id, n])), [g.nodes]);
  const outgoing = g.edges.filter((e) => e.source === node.id);
  const incoming = g.edges.filter((e) => e.target === node.id);
  const prov = (deref.data?.data?.provenance ?? null) as Record<string, unknown> | null;

  return (
    <div className="col gap3" data-testid="node-inspector" data-node-id={node.id}>
      <div className="row gap2" style={{ flexWrap: 'wrap' }}>
        <Badge outline>{node.type}</Badge>
        {node.support && <Badge tone={SUPPORT_TONE[node.support]}>{node.support}</Badge>}
        {node.recheckRequired && <Badge tone="warn">recheck required</Badge>}
        {node.tombstone && <Badge tone="bad">tombstone</Badge>}
        {node.evidenceUnavailable && <Badge tone="bad">evidence unavailable</Badge>}
        {node.confidenceTier && <Badge tone="warn">{node.confidenceTier}</Badge>}
      </div>
      <div className="small strong">{node.label}</div>
      <div className="tiny mono dim">{node.id}</div>

      {node.missing && node.missing.length > 0 && (
        <Notice tone="warn" title="Unsupported: missing provenance">
          <span className="mono small">{node.missing.join(', ')}</span>
        </Notice>
      )}

      <Slot q={deref} rows={2}>
        {(d) => (
          <div className="col gap2" data-testid="deref">
            {d.tombstone ? (
              <Notice tone="bad" title="Payload removed">
                This item is a tombstone. Its identity and hash remain; the payload is not available.
              </Notice>
            ) : null}
            {d.rawObjectHash && <div className="tiny mono">raw {shortHash(d.rawObjectHash, 12, 6)}</div>}
            {prov && (
              <dl style={{ margin: 0 }}>
                {Object.entries(prov).map(([k, v]) => (
                  <div className="kv" key={k}>
                    <dt>{k}</dt>
                    <dd className="mono small" style={{ wordBreak: 'break-all' }}>
                      {Array.isArray(v) ? v.join(', ') : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {Array.isArray(d.data?.limitations) && (
              <div>
                <div className="label">Limitations</div>
                <ul className="small">{(d.data.limitations as string[]).slice(0, 6).map((l, i) => <li key={i}>{l}</li>)}</ul>
              </div>
            )}
            {Array.isArray(d.data?.skepticNotes) && (
              <div>
                <div className="label">Skeptic notes</div>
                <ul className="small">{(d.data.skepticNotes as string[]).slice(0, 4).map((l, i) => <li key={i}>{l}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </Slot>

      {(outgoing.length > 0 || incoming.length > 0) && (
        <div className="col gap1">
          <div className="label">Chain</div>
          {outgoing.map((e) => (
            <NeighbourRow key={e.id} rel={`${e.relation} →`} n={byId.get(e.target)} onFocus={onFocus} />
          ))}
          {incoming.map((e) => (
            <NeighbourRow key={e.id} rel={`← ${e.relation}`} n={byId.get(e.source)} onFocus={onFocus} />
          ))}
        </div>
      )}

      <div className="row gap2" style={{ flexWrap: 'wrap' }}>
        {node.type === 'claim' && (
          <Link className="btn" href={`/w/${wid}/claims/${node.id}`}>
            Open claim
          </Link>
        )}
        {node.type === 'query' && typeof node.data?.panelId === 'string' && (
          <Link className="btn" href={`/w/${wid}/panels/${node.data.panelId}`}>
            Open panel
          </Link>
        )}
        {node.type === 'marker' && (
          <Link className="btn" href={`/w/${wid}/markers/${node.id}`}>
            Open marker
          </Link>
        )}
        {node.type === 'hypothesis' && (
          <Link className="btn" href={`/w/${wid}/hypotheses`}>
            Hypotheses
          </Link>
        )}
      </div>

      <Comments wid={wid} nodeId={node.id} />
    </div>
  );
}

function NeighbourRow({ rel, n, onFocus }: { rel: string; n: GraphNode | undefined; onFocus?: (id: string) => void }) {
  if (!n) return <div className="tiny dim">{rel} (not shown)</div>;
  return (
    <button type="button" className="btn ghost" style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '4px 6px' }} onClick={() => onFocus?.(n.id)}>
      <span className="tiny dim">{rel}</span>&nbsp;
      <span className="small">{n.type}: {n.label.slice(0, 60)}</span>
    </button>
  );
}

export function Comments({ wid, nodeId }: { wid: string; nodeId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const q = useQuery({ queryKey: rk.comments(wid, nodeId), queryFn: () => research.comments(wid, nodeId) });
  const add = useMutation({
    mutationFn: () => research.addComment(wid, nodeId, body.trim()),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: rk.comments(wid, nodeId) });
    },
  });
  return (
    <div className="col gap2" data-testid="comments">
      <div className="label">Review comments</div>
      <Slot q={q} rows={1}>
        {(d) =>
          d.comments.length === 0 ? (
            <div className="small dim">No comments yet.</div>
          ) : (
            <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
              {d.comments.map((c, i) => (
                <li key={String(c.commentId ?? c.id ?? i)}>
                  {c.body} <span className="tiny dim">{formatUtc(c.createdAt)}</span>
                </li>
              ))}
            </ul>
          )
        }
      </Slot>
      <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a review comment" aria-label="Review comment" />
      <Button disabled={!body.trim()} disabledReason="Write a comment first." pending={add.isPending} onClick={() => add.mutate()}>
        Add comment
      </Button>
      <MutationError error={add.error} />
    </div>
  );
}

/* ------------------------------------------------------------------ list tab */
function ListTab({ wid, g }: { wid: string; g: GraphProjection }) {
  const [kind, setKind] = useState('all');
  const [sel, setSel] = useState<string | null>(null);
  const kinds = useMemo(() => ['all', ...Array.from(new Set(g.nodes.map((n) => n.type))).sort()], [g.nodes]);
  const rows = g.nodes.filter((n) => kind === 'all' || n.type === kind);
  const node = sel ? g.nodes.find((n) => n.id === sel) : undefined;
  const cols: Column<GraphNode>[] = [
    { key: 'type', header: 'Kind', render: (n) => <Badge outline>{n.type}</Badge> },
    { key: 'label', header: 'Label', width: '50%', render: (n) => <span className="small">{n.label.slice(0, 160)}</span> },
    {
      key: 'state',
      header: 'State',
      render: (n) => (
        <span className="row gap1">
          {n.support && <Badge tone={SUPPORT_TONE[n.support]}>{n.support}</Badge>}
          {n.recheckRequired && <Badge tone="warn">recheck</Badge>}
          {n.tombstone && <Badge tone="bad">tombstone</Badge>}
        </span>
      ),
    },
    { key: 'id', header: 'Id', render: (n) => <span className="tiny mono">{n.id.slice(0, 8)}</span> },
  ];
  return (
    <div className="grid c2" style={{ alignItems: 'start' }} data-testid="evidence-list">
      <div className="col gap2">
        <div className="row gap2" style={{ flexWrap: 'wrap' }}>
          {kinds.map((k) => (
            <Button key={k} variant={k === kind ? 'primary' : 'secondary'} onClick={() => setKind(k)}>
              {k}
            </Button>
          ))}
        </div>
        <DataTable caption="Evidence nodes" columns={cols} rows={rows} rowKey={(n) => n.id} onRowClick={(n) => setSel(n.id)} />
      </div>
      <Card title="Inspector">
        {node ? <NodeInspector wid={wid} node={node} g={g} onFocus={setSel} /> : <div className="small dim">Select a row to open its record.</div>}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- rechecks tab */
function RechecksTab({ wid, g }: { wid: string; g: GraphProjection }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: rk.rechecks(wid), queryFn: () => research.rechecks(wid) });
  const [note, setNote] = useState('');
  const resolve = useMutation({
    mutationFn: (nodeId: string) => research.resolveRecheck(wid, nodeId, note || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rk.rechecks(wid) });
      void qc.invalidateQueries({ queryKey: rk.graph(wid) });
    },
  });
  return (
    <Slot q={q}>
      {(d) =>
        d.flags.length === 0 ? (
          <EmptyState title="Nothing to recheck" body="No semantic-version change has flagged a node for revalidation." />
        ) : (
          <div className="col gap2" data-testid="rechecks">
            <Field label="Resolution note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </Field>
            {d.flags.map((f, i) => {
              const id = String(f.nodeId ?? f.id ?? i);
              const n = g.nodes.find((x) => x.id === id);
              return (
                <Card key={id} title={n?.label ?? id}>
                  <pre className="rs-pre">{JSON.stringify(f, null, 2)}</pre>
                  <Button pending={resolve.isPending} onClick={() => resolve.mutate(id)}>
                    Mark rechecked
                  </Button>
                </Card>
              );
            })}
            <MutationError error={resolve.error} />
          </div>
        )
      }
    </Slot>
  );
}

/* ---------------------------------------------------------------- impact tab */
function ImpactTab({ wid }: { wid: string }) {
  const metrics = useQuery({ queryKey: ['global', 'metrics'], queryFn: () => browserApi.get<{ metrics: { metricKey: string; displayName: string; status: string }[] }>('/v1/metrics') });
  const [metric, setMetric] = useState('');
  const [asked, setAsked] = useState('');
  const impact = useQuery({ queryKey: rk.impact(wid, asked), queryFn: () => research.impact(wid, asked), enabled: !!asked });
  return (
    <div className="col gap3" data-testid="impact">
      <Card title="Impact analysis" subtitle="Which claims, results and panels depend on a metric's current version.">
        <div className="row gap2" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
          <Field label="Metric id">
            <Input list="metric-ids" value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="live.near_tx_count" aria-label="Metric id" />
            <datalist id="metric-ids">{metrics.data?.metrics.map((m) => <option key={m.metricKey} value={m.metricKey}>{m.displayName}</option>)}</datalist>
          </Field>
          <Button variant="primary" disabled={!metric.trim()} disabledReason="Enter a metric id." onClick={() => setAsked(metric.trim())}>
            Analyse
          </Button>
        </div>
      </Card>
      {asked && (
        <Slot q={impact}>
          {(d) => (
            <div className="col gap2">
              <div className="row gap2">
                <Badge outline>version {d.currentVersion ?? 'unknown'}</Badge>
                <Badge outline>{d.affected.length} affected</Badge>
                {d.truncated && <Badge tone="warn">truncated</Badge>}
                {d.cycles.length > 0 && <Badge tone="warn">{d.cycles.length} cycle(s)</Badge>}
              </div>
              {d.affected.length === 0 ? (
                <EmptyState title="Nothing depends on this metric" body="No node in this workspace is pinned to it." />
              ) : (
                <pre className="rs-pre rs-scroll">{JSON.stringify(d.affected, null, 2)}</pre>
              )}
            </div>
          )}
        </Slot>
      )}
    </div>
  );
}
