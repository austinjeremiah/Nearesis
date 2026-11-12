import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.23 — thesis and report builder.
 *
 * The claim table is the document. Each row carries a verdict, an estimate,
 * a counterexample, a falsification condition and a provenance link, which is
 * what the NEAR thesis brief asks for and also what stops a report from being
 * a persuasive essay with charts attached.
 */
export default async function ThesisPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  const claims = db.claims(wid);
  const caps = db.capsules(wid);
  const latest = caps[0];
  const blockers = [
    { ok: claims.length > 0, label: 'At least one claim with a verdict' },
    { ok: db.hypotheses(wid).some((h) => h.registered), label: 'A frozen preregistration' },
    { ok: Boolean(latest?.reproducible), label: 'A capsule that rebuilds offline' },
    { ok: false, label: 'Chain commitment of the document digest' },
    { ok: db.sources().every((s) => s.health !== 'unavailable'), label: 'No unavailable source in scope' },
  ];

  return (
    <>
      <PageHeader
        title="Thesis"
        description="The claim table, its counterevidence and what would change it."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Thesis' },
        ]}
        context={
          <>
            <Badge tone={ws.thesisStatus === 'published' ? 'ok' : 'warn'}>
              {ws.thesisStatus.replace(/_/g, ' ')}
            </Badge>
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          <>
            <Button disabled disabledReason="Validation needs the authorized API.">Run validation</Button>
            <Button variant="primary" disabled disabledReason="Publishing needs an approval bound to the document digest.">
              Publish version
            </Button>
          </>
        }
      />
      <Content>
        <Notice tone="warn" title="Numbers below refer to the frozen snapshot shown">
          Everything in this document is computed from <span className="mono">{db.SNAPSHOT_ID}</span>.
          Later source updates may differ, which is why the snapshot id travels with the claim
          rather than sitting in a footer.
        </Notice>

        <Card title="Claim table" subtitle="One row per claim. A row without a falsification condition cannot be published.">
          {claims.length === 0 ? (
            <EmptyState title="No claims yet" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 260 }}>Claim</th>
                    <th>Verdict</th>
                    <th>Estimate</th>
                    <th>Counterexample</th>
                    <th>Falsification</th>
                    <th>Provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link className="link small" href={`/w/${wid}/claims/${c.id}`}>
                          {c.statement}
                        </Link>
                      </td>
                      <td>
                        <EvidenceVerdict verdict={c.verdict} strength={c.strength} />
                      </td>
                      <td className="small">{c.estimate}</td>
                      <td className="small" style={{ color: 'var(--warn)' }}>
                        {c.counterexample}
                      </td>
                      <td className="small">{c.falsification}</td>
                      <td>
                        <Link className="link small mono" href={`/w/${wid}/evidence`}>
                          {c.evidenceResultIds[0] ?? '—'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Publication checklist" subtitle="A blocked item is shown, not skipped.">
            <div className="col gap2">
              {blockers.map((b) => (
                <div key={b.label} className="row gap3" style={{ borderBottom: '1px dashed var(--line)', padding: '6px 0' }}>
                  <Badge tone={b.ok ? 'ok' : 'warn'}>{b.ok ? 'Ready' : 'Blocked'}</Badge>
                  <span className="small grow">{b.label}</span>
                </div>
              ))}
            </div>
            <Notice tone="warn" title="Publishing is blocked">
              The document digest has not been committed on chain. That approval is pending and
              expires shortly; until it completes, this thesis can be exported but not published
              as a verified version.
            </Notice>
            <Link className="link small" href={`/w/${wid}/approvals`}>
              Open the pending approval
            </Link>
          </Card>

          <Card title="Document sections" subtitle="Generated from records, not written freehand.">
            <KeyValues
              rows={[
                { k: 'THESIS.md', v: 'Claim table, verdicts, counterevidence, falsification conditions' },
                { k: 'PREREGISTRATION.md', v: 'Frozen protocol with its canonical digest' },
                { k: 'EXPERIMENTS.md', v: 'Every run, including the ones reported as descriptive only' },
                { k: 'LIMITATIONS.md', v: 'Declared blind spots and what they prevent concluding' },
                { k: 'DATA.md and METRICS.md', v: 'Source manifest and certified measure definitions' },
                { k: 'dist/index.html', v: 'Static dashboard that opens with no credentials' },
              ]}
            />
            {latest && (
              <div className="row gap2">
                <LinkButton href={`/w/${wid}/capsules/${latest.hash}`}>Open capsule</LinkButton>
                <span className="tiny dim mono">{shortHash(latest.hash)}</span>
              </div>
            )}
          </Card>
        </div>

        <Card title="What would change our mind" subtitle="Required by the thesis brief, and the most useful section to a reader.">
          <ul className="col gap2" style={{ paddingLeft: 16, listStyle: 'disc' }}>
            <li className="small">
              If the cohort-adjusted forecast gain disappears across 15 or more origins, the
              predictive claim becomes unsupported rather than mixed.
            </li>
            <li className="small">
              If the reconstructable settlement share returns to within five points of its
              pre-boundary mean, the visibility claim is falsified.
            </li>
            <li className="small">
              If an independent fee series shows Intents revenue without the corresponding
              activity, the durability framing is wrong in the direction we did not test.
            </li>
          </ul>
          <p className="tiny dim">
            Last updated {formatUtc(ws.updatedAt)} from the current claim records.
          </p>
        </Card>
      </Content>
    </>
  );
}
