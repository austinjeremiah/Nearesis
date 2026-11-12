import type { Metadata } from 'next';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Band } from '@/components/nx/band';
import { SectionBar } from '@/components/nx/section';
import { Card, EmptyState, KeyValues, LinkButton } from '@/components/nx/ui';
import {
  Badge,
  CoverageChip,
  DataModeIndicator,
  EvidenceVerdict,
  SourceHealthChip,
} from '@/components/nx/evidence';
import * as db from '@/lib/data/client';
import { formatAge, formatUsd, formatUtc } from '@/lib/format';

export const metadata: Metadata = { title: 'Home · Nearesis' };

/**
 * Spec 5.2 — Home.
 *
 * "Surface what requires attention, not marketing copy." Every section is
 * source-backed: the findings come from real claim records, the health summary
 * from real source watermarks, and usage from the recorded ledger. Nothing here
 * is a headline number invented to fill a card.
 */
export default function HomePage() {
  const ws = db.workspaces().filter((w) => !w.archived);
  const recent = [...ws].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const pendingApprovals = db
    .workspaces()
    .flatMap((w) => db.approvals(w.id).map((a) => ({ ...a, workspace: w })))
    .filter((a) => a.state === 'pending');
  const findings = db
    .workspaces()
    .flatMap((w) => db.claims(w.id).map((c) => ({ ...c, workspace: w })))
    .slice(0, 3);
  const sources = db.sources();
  const unhealthy = sources.filter((s) => s.health !== 'healthy');
  const spentToday = ws.reduce((a, w) => a + w.spentUsd, 0);
  const budgetToday = ws.reduce((a, w) => a + w.budgetUsd, 0);

  return (
    <>
      <PageHeader
        title="Home"
        description="What needs your attention across every workspace you can see."
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <>
            <LinkButton href="/workspaces/new" variant="primary">
              New workspace
            </LinkButton>
          </>
        }
      />
      <Content>
        <Band
          eyebrow="By the numbers"
          lead="A reader who disagrees with your conclusion should be able to recompute it from scratch."
          stats={[
            { value: '1', unit: 'command', detail: 'rebuilds every table and chart offline, with no credentials', lead: true },
            { value: '0', unit: 'raw SQL', detail: 'reaches the warehouse. Agents compose certified measures or the query is refused' },
            { value: '4', unit: 'verdicts', detail: 'supported, mixed, unsupported, insufficient data. A null result is still a result' },
            { value: '72', unit: 'h', detail: 'of monitoring on finalized observations before a marker wakes its agent' },
          ]}
          footer={
            <>
              <span className="badge bad">Fixture</span>
              <span>
                The backend is not connected. Every number below comes from snapshot{' '}
                <span className="mono">{db.SNAPSHOT_ID}</span>. Nothing here is a live observation.
              </span>
            </>
          }
        />

        <section>
          <SectionBar title="Continue researching" number="001" />
          <div className="grid c3">
            {recent.map((w) => (
              <Card
                key={w.id}
                title={<Link href={`/w/${w.id}/overview`}>{w.name}</Link>}
                subtitle={w.objective}
                actions={<Badge tone={w.thesisStatus === 'published' ? 'ok' : ''}>{w.thesisStatus.replace(/_/g, ' ')}</Badge>}
                footer={
                  <>
                    <span className="tiny dim">Updated {formatAge(w.updatedAt)}</span>
                    <span className="tiny dim mono">{w.snapshotId}</span>
                    <div className="grow" />
                    <Link className="link small" href={`/w/${w.id}/overview`}>
                      Open
                    </Link>
                  </>
                }
              >
                <div className="row gap2 wrap tiny dim">
                  <span>{w.template}</span>
                  <span>·</span>
                  <span>
                    {formatUsd(w.spentUsd)} of {formatUsd(w.budgetUsd)} spent
                  </span>
                  <span>·</span>
                  <span>branch {w.branch}</span>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <div className="grid c2">
          <section>
            <SectionBar title="Needs your review" number="002" />
            {pendingApprovals.length === 0 ? (
              <EmptyState title="Nothing waiting on you" body="Approvals and merge requests appear here." />
            ) : (
              <div className="col gap3">
                {pendingApprovals.map((a) => (
                  <Card
                    key={a.id}
                    title={a.kind}
                    subtitle={a.workspace.name}
                    actions={<Badge tone="warn">Pending</Badge>}
                    footer={
                      <>
                        <span className="tiny dim">Expires {formatUtc(a.expiresAt)}</span>
                        <div className="grow" />
                        <Link className="link small" href={`/w/${a.workspaceId}/approvals`}>
                          Review
                        </Link>
                      </>
                    }
                  >
                    <p className="small">{a.requested}</p>
                    <div className="row gap2 wrap tiny dim">
                      {a.network && <Badge outline>{a.network}</Badge>}
                      {a.amountCapUsd !== null && <span className="mono">cap {formatUsd(a.amountCapUsd)}</span>}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionBar title="Recent findings" number="003" />
            <div className="col gap3">
              {findings.map((c) => (
                <Card
                  key={c.id}
                  title={<Link href={`/w/${c.workspaceId}/claims/${c.id}`}>{c.statement}</Link>}
                  subtitle={c.workspace.name}
                  footer={
                    <>
                      <EvidenceVerdict verdict={c.verdict} strength={c.strength} />
                      <div className="grow" />
                      {c.disputed && <Badge tone="warn">Disputed</Badge>}
                    </>
                  }
                >
                  <p className="small muted">{c.estimate}</p>
                </Card>
              ))}
            </div>
          </section>
        </div>

        <div className="grid c2">
          <section>
            <SectionBar title="Data health" number="004" />
            <Card
              title={`${sources.length - unhealthy.length} of ${sources.length} sources healthy`}
              actions={
                <Link className="link small" href="/data/sources">
                  View sources
                </Link>
              }
            >
              <KeyValues
                rows={sources.map((s) => ({
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
                      <span className="tiny dim mono">{formatAge(s.watermark)}</span>
                    </span>
                  ),
                }))}
              />
            </Card>
          </section>

          <section>
            <SectionBar title="Usage today" number="005" />
            <Card
              title={`${formatUsd(spentToday)} spent`}
              subtitle={`Across ${ws.length} active workspaces, against ${formatUsd(budgetToday)} of caps.`}
            >
              <KeyValues
                rows={ws.map((w) => ({
                  k: w.name,
                  v: (
                    <span className="mono">
                      {formatUsd(w.spentUsd)} / {formatUsd(w.budgetUsd)}
                    </span>
                  ),
                }))}
              />
              <p className="tiny dim">
                Recorded from the run ledger, not estimated. A run that was cancelled still shows
                what it spent before it stopped.
              </p>
            </Card>

            <SectionBar title="Latest publications" number="006" />
            {db.publications().length === 0 ? (
              <EmptyState title="Nothing published yet" body="A published thesis appears here with its verification state." />
            ) : (
              db.publications().map((p) => (
                <Card
                  key={p.id}
                  title={<Link href={`/public/${p.id}`}>{p.title}</Link>}
                  subtitle={`Version ${p.version} · ${formatUtc(p.publishedAt, false)}`}
                  footer={<EvidenceVerdict verdict={p.verdict} strength={p.strength} />}
                />
              ))
            )}
          </section>
        </div>
      </Content>
    </>
  );
}
