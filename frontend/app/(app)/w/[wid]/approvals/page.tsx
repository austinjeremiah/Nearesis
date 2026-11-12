import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { ApprovalChip, Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc } from '@/lib/format';

/**
 * Spec 5.26 — approvals.
 *
 * An approval is bound to one exact payload digest. Change a parameter and the
 * approval is void, which is the property that stops an agent getting consent
 * for a small action and performing a larger one. The page never asks for a
 * seed phrase or a private key, and there is nowhere here to enter one.
 */
export default async function ApprovalsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.approvals(wid);
  const pending = rows.filter((a) => a.state === 'pending');

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Actions that need a person. Each one is bound to an exact payload."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Approvals' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <Notice tone="info" title="Nearesis will never ask for a seed phrase or a private key">
          Approving an on-chain action signs from your own account through your own wallet. There
          is no field anywhere in this product that accepts key material, and anything that asks
          for one is not us.
        </Notice>

        {rows.length === 0 ? (
          <EmptyState title="Nothing to approve" />
        ) : (
          <div className="col gap4">
            {rows.map((a) => (
              <Card
                key={a.id}
                title={a.kind}
                subtitle={a.requested}
                actions={<ApprovalChip state={a.state} />}
                footer={
                  a.state === 'pending' ? (
                    <>
                      <Button disabled disabledReason="Approving needs the authorized API and your wallet.">
                        Approve exact action
                      </Button>
                      <Button disabled disabledReason="Rejecting needs the authorized API.">Reject</Button>
                      <Button disabled disabledReason="Requesting changes needs the authorized API.">
                        Request changes
                      </Button>
                      <div className="grow" />
                      <span className="tiny dim mono">Expires {formatUtc(a.expiresAt)}</span>
                    </>
                  ) : (
                    <span className="tiny dim mono">Closed {formatUtc(a.expiresAt)}</span>
                  )
                }
              >
                <KeyValues
                  rows={[
                    { k: 'Issuer', v: <Badge outline>{a.issuer}</Badge> },
                    {
                      k: 'Payload digest',
                      v: <span className="mono" style={{ wordBreak: 'break-all' }}>{a.payloadHash}</span>,
                    },
                    { k: 'Network', v: a.network ?? <span className="unavailable" /> },
                    {
                      k: 'Amount cap',
                      v: a.amountCapUsd !== null ? <span className="mono">{formatUsd(a.amountCapUsd)}</span> : <span className="unavailable" />,
                    },
                    {
                      k: 'Side effects',
                      v: (
                        <ul style={{ paddingLeft: 16, listStyle: 'disc' }}>
                          {a.sideEffects.map((s) => (
                            <li key={s} className="small">
                              {s}
                            </li>
                          ))}
                        </ul>
                      ),
                    },
                  ]}
                />
              </Card>
            ))}
          </div>
        )}

        {pending.length > 0 && (
          <Notice tone="warn" title="An approval expires rather than waiting indefinitely">
            A stale approval is a standing permission nobody is watching. These expire in minutes,
            and an expired one has to be re-requested with a fresh digest.
          </Notice>
        )}
      </Content>
    </>
  );
}
