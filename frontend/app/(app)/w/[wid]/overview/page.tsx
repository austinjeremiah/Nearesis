import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader, RunStrip } from '@/components/nx/shell';
import { PanelFrame } from '@/components/nx/panel';
import {
  Badge,
  CoverageChip,
  DataModeIndicator,
  EvidenceVerdict,
  RunStatus,
  SourceHealthChip,
} from '@/components/nx/evidence';
import {
  BudgetMeter,
  Card,
  EmptyState,
  KeyValues,
  LinkButton,
  Notice,
} from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import type { ClaimVerdict } from '@/lib/contracts';
import { formatAge, formatUsd, formatUtc } from '@/lib/format';

/**
 * Spec 5.5 — workspace overview.
 *
 * Cards in the reading order the spec sets: thesis status, latest
 * investigation, pinned research surface, evidence summary, monitors, timeline,
 * source coverage, publication. Every card deep-links to the real screen, and
 * an empty workspace offers a first action rather than inventing KPIs.
 */
export default async function OverviewPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  const pinned = db.panels(wid).filter((p) => p.pinned);
  const claims = db.claims(wid);
  const monitors = db.monitors(wid);
  const events = db.timeline(wid).slice(0, 8);
  const active = db.activeRun(wid);
  const latestRun = db.runs(wid)[0];
  const pub = db.publications().find((p) => p.workspaceId === wid);

  const counts = (['supported', 'mixed', 'unsupported', 'insufficient_data'] as ClaimVerdict[]).map(
    (v) => ({ verdict: v, n: claims.filter((c) => c.verdict === v).length }),
  );

  return (
    <>
      <PageHeader
        title={ws.name}
        description={ws.objective}
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: ws.name }]}
        context={
          <>
            <Badge outline>branch {ws.branch}</Badge>
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          <>
            <LinkButton href={`/w/${wid}/investigate`} variant="primary">
              Ask a question
            </LinkButton>
            <LinkButton href={`/w/${wid}/canvas`}>Open canvas</LinkButton>
          </>
        }
      />

      <Content>
        <div className="grid c3">
          <Card title="Thesis status" actions={<Badge tone={ws.thesisStatus === 'published' ? 'ok' : 'warn'}>{ws.thesisStatus.replace(/_/g, ' ')}</Badge>}>
            <KeyValues
              rows={[
                {
                  k: 'Headline verdict',
                  v: claims.length ? (
                    <EvidenceVerdict verdict={claims[0].verdict} strength={claims[0].strength} />
                  ) : (
                    <span className="unavailable" />
                  ),
                },
                { k: 'Claims', v: <span className="mono">{claims.length}</span> },
                { k: 'Snapshot', v: <span className="mono">{ws.snapshotId}</span> },
              ]}
            />
            <p className="tiny dim">
              Verdict and evidence strength are separate. A supported claim on weak evidence is not
              the same result as a supported claim on strong evidence.
            </p>
            <Link className="link small" href={`/w/${wid}/thesis`}>
              Open thesis
            </Link>
          </Card>

          <Card
            title="Latest investigation"
            actions={latestRun ? <RunStatus state={latestRun.state} /> : undefined}
          >
            {latestRun ? (
              <>
                <p className="small">{latestRun.question}</p>
                <KeyValues
                  rows={[
                    { k: 'Child agents', v: <span className="mono">{latestRun.tasks.length}</span> },
                    { k: 'Started', v: <span className="mono">{formatAge(latestRun.startedAt)}</span> },
                    {
                      k: 'Spend',
                      v: <span className="mono">{formatUsd(latestRun.spentUsd)} of {formatUsd(latestRun.budgetUsd)}</span>,
                    },
                  ]}
                />
                <Link className="link small" href={`/w/${wid}/runs/${latestRun.id}`}>
                  Resume view
                </Link>
              </>
            ) : (
              <EmptyState title="No investigation yet" body="Ask a question to start one." />
            )}
          </Card>

          <Card title="Budget">
            <BudgetMeter spentUsd={ws.spentUsd} budgetUsd={ws.budgetUsd} label="Workspace total" />
            <p className="tiny dim">
              Recorded from the run ledger. A cancelled run still shows what it spent before it
              stopped.
            </p>
            <Link className="link small" href={`/w/${wid}/agents`}>
              Agents and runs
            </Link>
          </Card>
        </div>

        <section className="col gap3">
          <div className="row between">
            <h2 className="label">Research surface</h2>
            <Link className="link small" href={`/w/${wid}/canvas`}>
              Open canvas
            </Link>
          </div>
          {pinned.length === 0 ? (
            <EmptyState
              title="Nothing pinned yet"
              body="Pin a panel from the canvas to keep it on this page. An empty workspace shows nothing rather than a placeholder chart."
              action={
                <Link className="btn primary" href={`/w/${wid}/canvas`}>
                  Add first panel
                </Link>
              }
            />
          ) : (
            <div className="grid c2">
              {pinned.map((p) => (
                <PanelFrame key={p.id} panel={p} workspaceId={wid} height={200} compactHeader />
              ))}
            </div>
          )}
        </section>

        <div className="grid c2">
          <Card
            title="Evidence summary"
            actions={
              <Link className="link small" href={`/w/${wid}/evidence`}>
                Evidence graph
              </Link>
            }
          >
            {claims.length === 0 ? (
              <EmptyState title="No claims yet" />
            ) : (
              <>
                <div className="row gap4 wrap">
                  {counts.map((c) => (
                    <div key={c.verdict} className="col gap1">
                      <span className="num lg">{c.n}</span>
                      <span className="tiny dim" style={{ textTransform: 'capitalize' }}>
                        {c.verdict.replace(/_/g, ' ')}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="tiny dim">
                  Counts, not a score. There is no single confidence percentage here because the
                  four verdicts mean different things.
                </p>
              </>
            )}
          </Card>

          <Card
            title="Monitors"
            actions={
              <Link className="link small" href={`/w/${wid}/monitors`}>
                Manage monitors
              </Link>
            }
          >
            <KeyValues
              rows={[
                { k: 'Enabled', v: <span className="mono">{monitors.filter((m) => m.enabled).length} of {monitors.length}</span> },
                {
                  k: 'Last trigger',
                  v: (
                    <span className="mono">
                      {formatUtc(
                        monitors
                          .map((m) => m.lastTriggered)
                          .filter(Boolean)
                          .sort()
                          .reverse()[0] ?? null,
                      )}
                    </span>
                  ),
                },
                {
                  k: 'Suppressed',
                  v: <span className="mono">{monitors.reduce((a, m) => a + m.suppressed, 0)}</span>,
                },
              ]}
            />
            <p className="tiny dim">
              Monitors read finalized observations only and wake an agent on breach. They never
              reschedule themselves indefinitely.
            </p>
          </Card>
        </div>

        <div className="grid c2">
          <Card
            title="Research timeline"
            actions={
              <Link className="link small" href={`/w/${wid}/timeline`}>
                Open full timeline
              </Link>
            }
          >
            <ol className="col gap2">
              {events.map((e) => (
                <li key={e.id} className="row top gap3" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 8 }}>
                  <span className="tiny dim mono" style={{ minWidth: 92 }}>
                    {formatAge(e.at)}
                  </span>
                  <div className="grow col gap1">
                    <span className="small strong">
                      {e.href ? <Link href={e.href}>{e.action}</Link> : e.action}
                    </span>
                    <span className="tiny dim">{e.detail}</span>
                  </div>
                  <Badge outline>{e.actorKind === 'agent' ? e.actor : e.actorKind === 'system' ? 'system' : 'you'}</Badge>
                </li>
              ))}
            </ol>
          </Card>

          <Card
            title="Source coverage"
            actions={
              <Link className="link small" href="/data/sources">
                View sources
              </Link>
            }
          >
            <KeyValues
              rows={db.sources().map((s) => ({
                k: s.name,
                v: (
                  <span className="row gap2 wrap">
                    <SourceHealthChip health={s.health} />
                    {s.coveragePct !== null ? (
                      <CoverageChip
                        coverage={{
                          expected: 180,
                          observed: Math.round(180 * s.coveragePct),
                          unknown: Math.round(180 * (1 - s.coveragePct)),
                          gaps: [],
                        }}
                      />
                    ) : (
                      <Badge outline>Not sampled</Badge>
                    )}
                  </span>
                ),
              }))}
            />
            <Notice tone="warn" title="Declared blind spot">
              After {db.SETTLEMENT_BOUNDARY} a growing share of 1Click settlement cannot be
              reconstructed from public NEAR transaction hashes. Totals after that date are a lower
              bound, not a measurement.
            </Notice>
          </Card>
        </div>

        <Card
          title="Publication"
          actions={
            <Link className="link small" href={`/w/${wid}/thesis`}>
              Open thesis
            </Link>
          }
        >
          {pub ? (
            <KeyValues
              rows={[
                { k: 'Latest version', v: <span className="mono">{pub.version}</span> },
                { k: 'Published', v: <span className="mono">{formatUtc(pub.publishedAt)}</span> },
                { k: 'Verdict', v: <EvidenceVerdict verdict={pub.verdict} strength={pub.strength} /> },
              ]}
            />
          ) : (
            <EmptyState
              title="Not published"
              body="Publishing requires a frozen snapshot, a validated claim table and an approval bound to the document digest."
              action={
                <Link className="btn" href={`/w/${wid}/thesis`}>
                  Open thesis builder
                </Link>
              }
            />
          )}
        </Card>
      </Content>

      {active && (
        <RunStrip
          label={active.question}
          detail={`${active.tasks.length} task · ${formatUsd(active.spentUsd)} of ${formatUsd(active.budgetUsd)}`}
          href={`/w/${wid}/runs/${active.id}`}
        />
      )}
    </>
  );
}
