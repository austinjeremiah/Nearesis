import type { Metadata } from 'next';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { SectionBar } from '@/components/nx/section';
import { Card, EmptyState, LinkButton } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState, NotConnected } from '@/components/nx/states';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { formatAge } from '@/lib/format';

export const metadata: Metadata = { title: 'Home · Nearesis' };

/**
 * Spec 5.2 — Home. First vertical slice: the workspaces you can open, from
 * GET /v1/workspaces. The attention queue (approvals, findings, source
 * health, spend) needs aggregate routes the API does not have yet, so it
 * says so instead of showing numbers.
 */
export default async function HomePage() {
  const r = await settle(api.workspaces());
  const recent = r.ok
    ? [...r.data.workspaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6)
    : [];

  return (
    <>
      <PageHeader
        title="Home"
        description="What needs your attention across every workspace you can see."
        actions={
          <LinkButton href="/workspaces/new" variant="primary">
            New workspace
          </LinkButton>
        }
      />
      <Content>
        <section>
          <SectionBar title="Continue researching" number="001" />
          {!r.ok ? (
            <ApiErrorState error={r.error} />
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
                  actions={<Badge outline>{w.networkScope}</Badge>}
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

        <section>
          <SectionBar title="Needs attention" number="002" />
          <NotConnected what="The cross-workspace attention queue (pending approvals, new findings, source health, spend)" stream="WS1" />
        </section>
      </Content>
    </>
  );
}
