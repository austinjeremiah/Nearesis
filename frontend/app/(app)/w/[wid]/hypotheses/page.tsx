import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.12 — hypotheses.
 *
 * The page exists to make the order of events visible: a hypothesis is written,
 * frozen with a hash, and only then evaluated. After a freeze an edit creates an
 * amendment rather than mutating the old hash, which is the whole point of
 * registering it.
 */
export default async function HypothesesPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.hypotheses(wid);

  return (
    <>
      <PageHeader
        title="Hypotheses"
        description="Each one states what would prove it wrong, before it is tested."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Hypotheses' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <Button disabled disabledReason="Creating a hypothesis needs the authorized API.">
            New hypothesis
          </Button>
        }
      />
      <Content>
        <Notice tone="info" title="Why a falsification threshold is required">
          A loss function and a lag grid are easy to choose after seeing the answer. Freezing them
          first, and hashing the document, makes that choice auditable instead of invisible. A
          hypothesis without a threshold cannot be registered.
        </Notice>

        {rows.length === 0 ? (
          <EmptyState title="No hypotheses yet" body="Every thesis starts with a question you can lose." />
        ) : (
          <div className="col gap4">
            {rows.map((hy) => (
              <Card
                key={hy.id}
                title={hy.proposition}
                actions={
                  hy.registered ? (
                    <Badge tone="ok" title="Frozen. Later edits create an amendment.">
                      Registered
                    </Badge>
                  ) : (
                    <Badge tone="warn">Draft</Badge>
                  )
                }
                footer={
                  <>
                    {hy.verdict ? (
                      <EvidenceVerdict verdict={hy.verdict} strength={hy.strength ?? undefined} />
                    ) : (
                      <span className="small dim">No verdict yet</span>
                    )}
                    <div className="grow" />
                    <Link className="link small" href={`/w/${wid}/experiments`}>
                      {hy.experimentCount} experiment{hy.experimentCount === 1 ? '' : 's'}
                    </Link>
                  </>
                }
              >
                <KeyValues
                  rows={[
                    {
                      k: 'Target',
                      v: (
                        <Link className="link mono" href={`/data/metrics/${hy.target}`}>
                          {hy.target}
                        </Link>
                      ),
                    },
                    { k: 'Predictor', v: <span className="mono">{hy.predictor}</span> },
                    { k: 'Benchmark', v: hy.benchmark },
                    {
                      k: 'Falsification threshold',
                      v: <span style={{ color: 'var(--warn)' }}>{hy.falsification}</span>,
                    },
                    { k: 'Version', v: <span className="mono">{hy.version}</span> },
                    {
                      k: 'Registration',
                      v: hy.registered ? (
                        <span className="col gap1">
                          <span className="mono" title={hy.registrationHash}>
                            {shortHash(hy.registrationHash ?? '')}
                          </span>
                          <span className="tiny dim">Frozen {formatUtc(hy.registeredAt ?? null)}</span>
                        </span>
                      ) : (
                        <span className="unavailable" />
                      ),
                    },
                  ]}
                />
                <div className="row gap2 wrap">
                  <LinkButton href={`/w/${wid}/experiments`}>Create experiment</LinkButton>
                  {hy.registered ? (
                    <Button disabled disabledReason="Already frozen. An edit creates an amendment with a new hash.">
                      Preregister
                    </Button>
                  ) : (
                    <Button disabled disabledReason="Freezing a preregistration needs owner approval and the authorized API.">
                      Preregister
                    </Button>
                  )}
                  <Button disabled disabledReason="Forking an alternative needs the authorized API.">
                    Fork alternative
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Content>
    </>
  );
}
