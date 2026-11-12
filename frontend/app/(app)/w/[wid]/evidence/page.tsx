import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Card, EmptyState, Notice } from '@/components/nx/ui';
import type { GraphEdge, GraphNode } from '@/components/nx/graph';
import { EvidenceExplorer } from './explorer';
import * as db from '@/lib/data/client';
import { shortHash } from '@/lib/format';

/**
 * Spec 5.18 — Evidence Graph.
 *
 * The chain a reviewer follows: hypothesis, claim, result, query, semantic
 * version, raw source snapshot. It is laid out left to right because the
 * question a reader has is "where did this number come from", and a straight
 * line answers it faster than a cloud of nodes — but it is a real graph, so the
 * nodes that several claims share are drawn once and the links to them are
 * visible. The written chain is still one click away for reading and for
 * assistive technology.
 */

const COL = 272; // node width plus the gap the connectors need
const ROW = 184;

export default async function EvidencePage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  const claims = db.claims(wid);
  const panels = db.panels(wid);
  const hypotheses = db.hypotheses(wid);

  /* ---------------------------------------------------------------------------
     Graph model.

     One row per claim. Nodes that more than one claim depends on — a shared
     hypothesis, the semantic version, the raw snapshot — are emitted once and
     parked at the average height of the rows that reach them, so a reader can
     see at a glance which records the whole thesis is resting on.
     ------------------------------------------------------------------------ */
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const rowsFor = new Map<string, number[]>();

  const track = (id: string, row: number) => {
    rowsFor.set(id, [...(rowsFor.get(id) ?? []), row]);
  };
  const push = (n: GraphNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  const link = (from: string, to: string) => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };

  claims.forEach((c, i) => {
    const y = i * ROW;
    const hy = hypotheses.find((h) => h.id === c.hypothesisId);
    const panel = panels[i % Math.max(1, panels.length)];
    const result = panel ? db.resultFor(panel.metricIds) : null;

    const hid = `h:${c.hypothesisId}`;
    const cid = `c:${c.id}`;
    const rid = `r:${result?.resultId ?? c.evidenceResultIds[0] ?? c.id}`;
    const qid = `q:${result?.query.canonicalQueryHash ?? 'none'}`;

    track(hid, i);
    track(rid, i);
    track(qid, i);
    track('sem', i);
    track('snap', i);

    push({
      id: hid,
      kind: 'hypothesis',
      label: 'Hypothesis',
      title: hy?.proposition ?? c.hypothesisId,
      mono: c.hypothesisId,
      x: 0,
      y,
      detail: [
        { k: 'Benchmark', v: hy?.benchmark ?? '—' },
        { k: 'Registered', v: hy?.registered ? 'Yes' : 'No' },
        { k: 'Experiments', v: String(hy?.experimentCount ?? 0) },
      ],
      note: hy?.falsification,
      link: { label: 'Open hypothesis', href: `/w/${wid}/hypotheses` },
    });

    push({
      id: cid,
      kind: 'claim',
      label: `Claim · ${c.verdict.replace(/_/g, ' ')}`,
      title: c.statement,
      mono: c.id,
      x: COL,
      y,
      detail: [
        { k: 'Verdict', v: <EvidenceVerdict verdict={c.verdict} strength={c.strength} /> },
        { k: 'Estimate', v: c.estimate },
        { k: 'Disputed', v: c.disputed ? 'Yes' : 'No' },
      ],
      note: c.falsification,
      link: { label: 'Open claim', href: `/w/${wid}/claims/${c.id}` },
    });

    push({
      id: rid,
      kind: 'result',
      label: 'Result',
      title: `From ${hy?.experimentCount ?? 0} experiment${hy?.experimentCount === 1 ? '' : 's'}`,
      mono: result?.resultId ?? c.evidenceResultIds[0] ?? '—',
      x: COL * 2,
      y,
      detail: [
        { k: 'Rows', v: <span className="mono">{result?.rowCount ?? 0}</span> },
        {
          k: 'Result hash',
          v: <span className="mono">{result ? shortHash(result.resultHash) : '—'}</span>,
        },
        {
          k: 'Panel',
          v: panel?.title ?? '—',
        },
      ],
      note: 'A result is immutable. Re-running the query produces a new result, never an edit.',
      link: { label: 'Open experiments', href: `/w/${wid}/experiments` },
    });

    push({
      id: qid,
      kind: 'query',
      label: 'Query',
      title: `${result?.query.metricIds.length ?? 0} certified measures`,
      mono: result ? shortHash(result.query.canonicalQueryHash) : '—',
      x: COL * 3,
      y,
      detail: [
        {
          k: 'Measures',
          v: <span className="mono">{result?.query.metricIds.join(', ') ?? '—'}</span>,
        },
        { k: 'Snapshot', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
      ],
      note: 'Agents compose certified measures. Raw SQL never reaches the warehouse.',
    });

    link(hid, cid);
    link(cid, rid);
    link(rid, qid);
    link(qid, 'sem');
  });

  if (claims.length > 0) {
    push({
      id: 'sem',
      kind: 'semantic',
      label: 'Semantic version',
      title: 'Certified measure definitions',
      mono: db.SEMANTIC_VERSION,
      x: COL * 4,
      y: 0,
      detail: [{ k: 'Version', v: <span className="mono">{db.SEMANTIC_VERSION}</span> }],
      note: 'A measure definition changing is a version bump, so an old result stays reproducible.',
    });
    push({
      id: 'snap',
      kind: 'snapshot',
      label: 'Raw snapshot',
      title: 'Immutable source extract',
      mono: db.SNAPSHOT_ID,
      x: COL * 5,
      y: 0,
      detail: [
        { k: 'Snapshot', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
        { k: 'As of', v: <span className="mono">{db.SNAPSHOT_AS_OF}</span> },
      ],
      note: 'The end of every chain. Rebuildable offline from the manifest, with no credentials.',
    });
    link('sem', 'snap');
  }

  // Park the shared nodes level with the rows that reach them.
  const centre = (id: string) => {
    const rows = rowsFor.get(id);
    const node = nodes.find((n) => n.id === id);
    if (!rows || rows.length === 0 || !node) return;
    node.y = (rows.reduce((a, b) => a + b, 0) / rows.length) * ROW;
  };
  nodes
    .filter((n) => n.kind === 'hypothesis' || n.kind === 'result' || n.kind === 'query')
    .forEach((n) => centre(n.id));
  centre('sem');
  centre('snap');

  return (
    <>
      <PageHeader
        title="Evidence graph"
        description="Follow any claim down to the raw snapshot it was built from."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Evidence graph' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        {claims.length === 0 ? (
          <EmptyState title="No claims yet" body="A claim appears here once an investigation produces one." />
        ) : (
          <>
            <Notice tone="info" title="Every link in this chain is addressable">
              Nothing below is a summary of a summary. Each step resolves to a record with its own
              hash, and a reviewer can stop at any level and check it independently.
            </Notice>

            <EvidenceExplorer nodes={nodes} edges={edges}>
              <div className="col gap4">
                {claims.map((c, i) => {
                  const hy = hypotheses.find((h) => h.id === c.hypothesisId);
                  const relatedPanel = panels[i % Math.max(1, panels.length)];
                  const result = relatedPanel ? db.resultFor(relatedPanel.metricIds) : null;

                  return (
                    <Card
                      key={c.id}
                      title={<Link href={`/w/${wid}/claims/${c.id}`}>{c.statement}</Link>}
                      actions={<EvidenceVerdict verdict={c.verdict} strength={c.strength} />}
                    >
                      <div className="evidence-chain">
                        <div className="chain-step">
                          <span className="label">Claim</span>
                          <Link className="link small mono" href={`/w/${wid}/claims/${c.id}`}>
                            {c.id}
                          </Link>
                          <span className="tiny dim">{c.estimate}</span>
                        </div>

                        <span className="chain-arrow" aria-hidden="true">
                          →
                        </span>

                        <div className="chain-step">
                          <span className="label">Result</span>
                          {c.evidenceResultIds.map((r) => (
                            <span key={r} className="small mono">
                              {r}
                            </span>
                          ))}
                          <span className="tiny dim">
                            From {hy?.experimentCount ?? 0} experiment
                            {hy?.experimentCount === 1 ? '' : 's'}
                          </span>
                        </div>

                        <span className="chain-arrow" aria-hidden="true">
                          →
                        </span>

                        <div className="chain-step">
                          <span className="label">Query</span>
                          <span className="small mono">
                            {result ? shortHash(result.query.canonicalQueryHash) : '—'}
                          </span>
                          <span className="tiny dim">
                            {result?.query.metricIds.length ?? 0} certified measures
                          </span>
                        </div>

                        <span className="chain-arrow" aria-hidden="true">
                          →
                        </span>

                        <div className="chain-step">
                          <span className="label">Semantic version</span>
                          <span className="small mono">{db.SEMANTIC_VERSION}</span>
                          <span className="tiny dim">Certified measure definitions</span>
                        </div>

                        <span className="chain-arrow" aria-hidden="true">
                          →
                        </span>

                        <div className="chain-step">
                          <span className="label">Raw snapshot</span>
                          <span className="small mono">{db.SNAPSHOT_ID}</span>
                          <span className="tiny dim">
                            manifest {result ? shortHash(result.source.rawManifestHash, 6, 4) : '—'}
                          </span>
                        </div>
                      </div>

                      {c.disputed && (
                        <Notice tone="warn" title="This claim is disputed">
                          {c.counterexample}
                        </Notice>
                      )}

                      <div className="row gap2 wrap">
                        <Badge outline>hypothesis {c.hypothesisId}</Badge>
                        <Link className="link small" href={`/w/${wid}/claims/${c.id}`}>
                          Open claim
                        </Link>
                        <Link className="link small" href={`/w/${wid}/experiments`}>
                          Open experiments
                        </Link>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </EvidenceExplorer>
          </>
        )}
      </Content>
    </>
  );
}
