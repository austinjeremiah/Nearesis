import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Card, EmptyState, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/** Spec 5.27 — notifications: durable alerts, as opposed to ephemeral toasts. */
export default function NotificationsPage() {
  const rows = db.notifications();
  const unread = rows.filter((n) => !n.read);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Approvals, monitor findings and failures that outlive a toast."
        context={unread.length > 0 ? <Badge tone="warn">{unread.length} unread</Badge> : undefined}
      />
      <Content>
        {rows.length === 0 ? (
          <EmptyState title="Nothing to read" />
        ) : (
          <Card title={`${rows.length} notifications`}>
            <ol className="col">
              {rows.map((n) => (
                <li
                  key={n.id}
                  className="row top gap3"
                  style={{
                    borderBottom: '1px dashed var(--line)',
                    padding: '12px 0',
                    opacity: n.read ? 0.65 : 1,
                  }}
                >
                  <Badge
                    tone={n.kind === 'approval' ? 'warn' : n.kind === 'error' ? 'bad' : n.kind === 'publication' ? 'ok' : 'info'}
                  >
                    {n.kind}
                  </Badge>
                  <div className="grow col gap1">
                    <Link className="small strong" href={n.href}>
                      {n.title}
                    </Link>
                    <span className="tiny dim">{n.body}</span>
                  </div>
                  <span className="tiny dim mono">{formatUtc(n.at)}</span>
                  {!n.read && <span className="dot" style={{ color: 'var(--accent)' }} aria-label="Unread" />}
                </li>
              ))}
            </ol>
          </Card>
        )}

        <Notice tone="info" title="Why a failure appears twice">
          A failed refresh is listed here and stays visible on the panel it affected. A durable
          problem that only ever appeared as a toast is a problem nobody saw.
        </Notice>
      </Content>
    </>
  );
}
