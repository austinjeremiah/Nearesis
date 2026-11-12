import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Card, EmptyState, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { shortHash } from '@/lib/format';

/**
 * Spec 5.18 — Evidence Graph.
 *
 * The chain a reviewer follows: claim, result, query, semantic version, raw
 * source snapshot. Drawn as columns rather than a force layout, because the
 * question a reader has is "where did this number come from", and a straight
 * line answers it faster than a cloud of nodes.
 */
export default async function EvidencePage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  const claims = db.claims(wid);
  const panels = db.panels(wid);

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

            <div className="col gap4">
              {claims.map((c) => {
                const hy = db.hypotheses(wid).find((h) => h.id === c.hypothesisId);
                const relatedPanel = panels[0];
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
                          From {hy?.experimentCount ?? 0} experiment{hy?.experimentCount === 1 ? '' : 's'}
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
          </>
        )}
      </Content>
    </>
  );
}
