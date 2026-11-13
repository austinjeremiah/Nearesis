import type { Metadata } from 'next';
import Link from 'next/link';
import { Content } from '@/components/nx/shell';
import { BracketButton, PageHero } from '@/components/nx/landing';
import { SectionBar } from '@/components/nx/section';
import { SourceRows } from '@/components/nx/source-rows';
import { Card, EmptyState, KeyValues, SpendValue } from '@/components/nx/ui';
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
      <PageHero
        kicker="Portfolio"
        title="Home"
        lede="What needs your attention across every workspace you can see."
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={<BracketButton href="/workspaces/new">New workspace</BracketButton>}
      />
      <Content>
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
                {/*
                  Stacked rather than dot separated: in a three-up card the
                  separators wrapped onto their own line and left a dot hanging
                  at the end of a row.
                */}
                <dl className="meta-rows tiny">
                  <div>
                    <dt>Template</dt>
                    <dd>{w.template}</dd>
                  </div>
                  <div>
                    <dt>Spend</dt>
                    <dd>
                      <SpendValue spentUsd={w.spentUsd} budgetUsd={w.budgetUsd} />
                    </dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd className="mono">{w.branch}</dd>
                  </div>
                </dl>
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
              <div className="stack-even">
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
            <div className="stack-even">
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
              <SourceRows rows={sources} />
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
          </section>
        </div>

        {/*
          Publications are the output of the whole page, so they get their own
          full-width row instead of being stacked under Usage today, which left
          the left-hand column empty for the height of the list.
        */}
        <section>
          <SectionBar
            title="Latest publications"
            number="006"
            action={
              <Link className="link small" href="/publications">
                All publications
              </Link>
            }
          />
          {db.publications().length === 0 ? (
            <EmptyState title="Nothing published yet" body="A published thesis appears here with its verification state." />
          ) : (
            <div className="grid c3">
              {db.publications().map((p) => (
                <Card
                  key={p.id}
                  title={<Link href={`/public/${p.id}`}>{p.title}</Link>}
                  subtitle={`Version ${p.version} · ${formatUtc(p.publishedAt, false)}`}
                  footer={<EvidenceVerdict verdict={p.verdict} strength={p.strength} />}
                />
              ))}
            </div>
          )}
        </section>
      </Content>
    </>
  );
}
