import type { Metadata } from 'next';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { SectionBar } from '@/components/nx/section';
import { Card, EmptyState, LinkButton } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { api } from '@/lib/api/server';
import { shellServer } from '@/lib/api/shell-server';
import { settle } from '@/lib/api/guard';
import { formatAge, formatUsd } from '@/lib/format';
import HomeView from '@/components/nx/home/home-view';
import HomeTabs from '@/components/nx/home/home-tabs';

export const metadata: Metadata = { title: 'Home · Nearesis' };

/**
 * Home: the workspaces you can open (pinned first) and a cross-workspace
 * attention queue built only from API aggregates: pending approvals, unread
 * monitor notifications, sources that are not fresh, and the global spend
 * ceiling. An empty queue says so; nothing is invented.
 */
export default async function HomePage() {
  const [ws, pins, approvals, notes, sources, spend] = await Promise.all([
    settle(api.workspaces()),
    settle(shellServer.pins()),
    settle(shellServer.approvals('pending')),
    settle(shellServer.notifications({ unread: true, limit: 8 })),
    settle(shellServer.sources()),
    settle(shellServer.costGlobal()),
  ]);
  const pinned = new Set(pins.ok ? pins.data.pins.map((p) => p.workspaceId) : []);
  const recent = ws.ok
    ? [...ws.data.workspaces]
        .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6)
    : [];
  const staleSources = sources.ok ? sources.data.sources.filter((s) => s.state !== 'fresh' && s.state !== 'live') : [];
  const spendBad = spend.ok && spend.data.state !== 'ok';
  const nothing =
    approvals.ok && notes.ok && sources.ok && approvals.data.approvals.length === 0 && notes.data.unread === 0 && staleSources.length === 0 && !spendBad;

  return (
    <>
      <PageHeader
        title="Home"
        description="Live NEAR data, what the agents found, and your research."
        actions={
          <LinkButton href="/workspaces/new" variant="primary">
            New workspace
          </LinkButton>
        }
      />
      <Content>
        <HomeTabs
          overview={
            <div className="home-overview">
        <HomeView />
        <section>
          <SectionBar title="Continue researching" number="004" />
          {!ws.ok ? (
            <ApiErrorState error={ws.error} />
          ) : recent.length === 0 ? (
            <EmptyState
              title="Every thesis starts with a question"
              body="No research workspaces yet."
              action={
                <Link className="btn primary" href="/workspaces/new">
                  Create workspace
                </Link>
              }
            />
          ) : (
            <div className="grid c3" data-testid="recent-workspaces">
              {recent.map((w) => (
                <Card
                  key={w.id}
                  title={<Link href={`/w/${w.id}/overview`}>{w.objective}</Link>}
                  actions={
                    <span className="row gap1">
                      {pinned.has(w.id) && <Badge tone="accent">Pinned</Badge>}
                    </span>
                  }
                  footer={
                    <>
                      <span className="tiny dim">Created {formatAge(w.createdAt)}</span>
                      <div className="grow" />
                      <Link className="link small" href={`/w/${w.id}/overview`}>
                        Open
                      </Link>
                    </>
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section id="attention" data-testid="attention">
          <SectionBar title="Needs attention" number="005" />
          <div className="col gap3">
            {nothing && (
              <EmptyState title="Nothing needs you" body="No approvals are waiting, no unread notifications, every source is fresh and spend is under its ceiling." />
            )}

            {!approvals.ok ? (
              <ApiErrorState error={approvals.error} />
            ) : (
              approvals.data.approvals.length > 0 && (
                <Card title={`Approvals waiting (${approvals.data.approvals.length})`} subtitle="Each approval is bound to the exact action shown." >
                  <ul className="col gap2" data-testid="attention-approvals" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {approvals.data.approvals.slice(0, 8).map((a) => (
                      <li key={`${a.runId}-${a.approvalId}`} className="row gap2 wrap">
                        <Badge tone="warn">{a.kind ?? 'approval'}</Badge>
                        <Link className="link" href={`/w/${a.workspaceId}/approvals`}>
                          {a.workspaceObjective}
                        </Link>
                        <span className="tiny dim">
                          cost limit {a.costLimit === null ? 'not set' : formatUsd(a.costLimit)} · requested {formatAge(a.requestedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {approvals.data.approvals.length > 8 && <p className="tiny dim">Showing 8 of {approvals.data.approvals.length}. Open a workspace to see the rest.</p>}
                  {approvals.data.truncated && <p className="tiny dim">Some workspaces could not be included.</p>}
                </Card>
              )
            )}

            {!notes.ok ? (
              <ApiErrorState error={notes.error} />
            ) : (
              notes.data.unread > 0 && (
                <Card title={`Unread notifications (${notes.data.unread})`} actions={<Link className="link small" href="/notifications">All notifications</Link>}>
                  <ul className="col gap2" data-testid="attention-notifications" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {notes.data.notifications.map((n) => (
                      <li key={n.notificationId} className="row gap2 wrap">
                        <Badge outline>{n.mode}</Badge>
                        <Link className="link" href={`/w/${n.workspaceId}/monitors`}>
                          {n.title}
                        </Link>
                        <span className="tiny dim">{n.workspaceObjective} · {formatAge(n.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )
            )}

            {sources.ok && staleSources.length > 0 && (
              <Card title={`Sources not fresh (${staleSources.length})`} actions={<Link className="link small" href="/system">System health</Link>}>
                <ul className="col gap2" data-testid="attention-sources" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {staleSources.map((s) => (
                    <li key={s.sourceId} className="row gap2">
                      <Badge tone="warn">{s.state}</Badge>
                      <span className="mono">{s.sourceId}</span>
                      <span className="tiny dim">{s.gapCount ? `${s.gapCount} gaps` : ''}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {!sources.ok && <ApiErrorState error={sources.error} />}

            {spendBad && spend.ok && (
              <Card title="Global spend ceiling" actions={<Link className="link small" href="/system#spend">Details</Link>}>
                <p className="small" data-testid="attention-spend">
                  State <strong>{spend.data.state}</strong>: {formatUsd(spend.data.committedUsd)} of {formatUsd(spend.data.ceilingUsd)} committed.
                </p>
              </Card>
            )}
          </div>
        </section>
            </div>
          }
        />
      </Content>
    </>
  );
}
