'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { SectionBar } from '@/components/nx/section';
import { Badge } from '@/components/nx/evidence';
import { BudgetMeter, Card, EmptyState, KeyValues, Skeleton } from '@/components/nx/ui';
import { ApiErrorState, StateBanner } from '@/components/nx/states';
import { RunStrip } from '@/components/nx/shell';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { formatAge, formatUsd, formatUtc } from '@/lib/format';

const ACTIVE = new Set(['REQUESTED', 'PLANNING', 'APPROVAL_NEEDED', 'EXECUTING', 'EVIDENCE_REVIEW', 'CANVAS_PATCH_REVIEW']);

/** One card's data: skeleton while loading, a state component on failure, children on success. */
function Slot<T>({ q, children }: { q: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; children: (d: T) => React.ReactNode }) {
  if (q.isPending) return <Skeleton rows={3} />;
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <>{children(q.data as T)}</>;
}

export default function OverviewView({ wid }: { wid: string }) {
  const runs = useQuery({ queryKey: qk.runs(wid), queryFn: () => browserApi.runs(wid) });
  const elig = useQuery({ queryKey: qk.eligibility(wid), queryFn: () => browserApi.publicationEligibility(wid) });
  const monitors = useQuery({ queryKey: qk.monitors(wid), queryFn: () => browserApi.monitors(wid) });
  const timeline = useQuery({ queryKey: qk.timeline(wid), queryFn: () => browserApi.timeline(wid) });
  const sources = useQuery({ queryKey: qk.sources(wid), queryFn: () => browserApi.sources(wid) });
  const canvas = useQuery({ queryKey: qk.canvas(wid), queryFn: () => browserApi.canvas(wid) });
  const burn = useQuery({ queryKey: ['ws', wid, 'cost', 'burn'], queryFn: () => browserApi.costBurn(wid) });

  const latest = runs.data?.runs[0];
  const active = runs.data?.runs.find((r) => ACTIVE.has(r.state));

  return (
    <>
      <div className="grid c3">
        <Card title="Publication status">
          <Slot q={elig}>
            {(e) => (
              <>
                <KeyValues
                  rows={[
                    { k: 'Supported claims', v: <span className="mono" data-testid="supported-count">{e.supportedClaimIds.length}</span> },
                    { k: 'Eligible to publish', v: <span className="mono">{e.publicationEligibleIds.length}</span> },
                    { k: 'Unsupported', v: <span className="mono">{e.unsupportedSection.claims.length}</span> },
                    { k: 'Graph version', v: <span className="mono">{e.graphVersion}</span> },
                  ]}
                />
                <Link className="link small" href={`/w/${wid}/thesis`}>
                  Open thesis
                </Link>
              </>
            )}
          </Slot>
        </Card>

        <Card title="Latest investigation" actions={latest ? <Badge tone={latest.state === 'COMPLETE' ? 'ok' : latest.terminal ? 'warn' : 'info'}>{latest.state.replace(/_/g, ' ').toLowerCase()}</Badge> : undefined}>
          <Slot q={runs}>
            {(d) =>
              latest ? (
                <>
                  <p className="small">{latest.questionSummary}</p>
                  <KeyValues
                    rows={[
                      { k: 'Runs in this workspace', v: <span className="mono">{d.runs.length}</span> },
                      { k: 'Started', v: <span className="mono">{formatAge(latest.startedAt)}</span> },
                      { k: 'Updated', v: <span className="mono">{formatAge(latest.updatedAt)}</span> },
                    ]}
                  />
                  <Link className="link small" href={`/w/${wid}/runs/${latest.runId}`}>
                    Open run
                  </Link>
                </>
              ) : (
                <EmptyState title="No investigation yet" body="Ask a question to start one." />
              )
            }
          </Slot>
        </Card>

        <Card title="Budget">
          <Slot q={burn}>
            {(b) => (
              <>
                {b.capUsd !== null ? (
                  <BudgetMeter spentUsd={b.spentUsd} budgetUsd={b.capUsd} label="This period" />
                ) : (
                  <KeyValues
                    rows={[
                      { k: 'Spent this period', v: <span className="mono">{formatUsd(b.spentUsd)}</span> },
                      { k: 'Cap', v: <span className="dim">No cap set</span> },
                    ]}
                  />
                )}
                {b.hardStopped && (
                  <StateBanner state="budget_exhausted" detail={b.hardStopReason ?? undefined} />
                )}
                <p className="tiny dim">Recorded from the cost ledger. Reserved: {formatUsd(b.reservedUsd)}.</p>
              </>
            )}
          </Slot>
        </Card>
      </div>

      <section>
        <SectionBar
          title="Research surface"
          number="001"
          action={
            <Link className="link small" href={`/w/${wid}/canvas`}>
              Open canvas
            </Link>
          }
        />
        <Slot q={canvas}>
          {(c) =>
            c.panels.length === 0 ? (
              <EmptyState
                title="No panels yet"
                body="Panels appear on the canvas once an investigation produces them."
                action={
                  <Link className="btn primary" href={`/w/${wid}/investigate`}>
                    Ask a question
                  </Link>
                }
              />
            ) : (
              <div className="grid c3" data-testid="panel-list">
                {c.panels.map((p) => (
                  <Card key={p.panelId} title={p.title} actions={<Badge outline>{p.kind}</Badge>}>
                    <p className="tiny dim mono">{p.panelId}</p>
                  </Card>
                ))}
              </div>
            )
          }
        </Slot>
        <p className="tiny dim">Charts render on the canvas page once its data stream is connected.</p>
      </section>

      <div className="grid c2">
        <Card
          title="Monitors"
          actions={
            <Link className="link small" href={`/w/${wid}/monitors`}>
              Manage monitors
            </Link>
          }
        >
          <Slot q={monitors}>
            {(m) => (
              <KeyValues
                rows={[
                  { k: 'Rules', v: <span className="mono">{m.rules.length}</span> },
                  { k: 'Enabled', v: <span className="mono">{m.rules.filter((r) => r.enabled).length}</span> },
                ]}
              />
            )}
          </Slot>
        </Card>

        <Card
          title="Source coverage"
          actions={
            <Link className="link small" href="/data/sources">
              View sources
            </Link>
          }
        >
          <Slot q={sources}>
            {(s) =>
              s.sources.length === 0 ? (
                <EmptyState title="No sources reported" body="This workspace has not read from any source yet." />
              ) : (
                <KeyValues
                  rows={s.sources.map((x) => ({
                    k: x.name,
                    v: (
                      <span className="row gap2 wrap">
                        <Badge tone={x.freshness === 'fresh' ? 'ok' : x.freshness === 'unavailable' ? 'bad' : 'warn'}>{x.freshness}</Badge>
                        <span className="tiny dim mono">{x.watermark ? formatUtc(x.watermark) : 'no watermark'}</span>
                      </span>
                    ),
                  }))}
                />
              )
            }
          </Slot>
        </Card>
      </div>

      <Card
        title="Research timeline"
        actions={
          <Link className="link small" href={`/w/${wid}/timeline`}>
            Open full timeline
          </Link>
        }
      >
        <Slot q={timeline}>
          {(t) =>
            t.entries.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ol className="col gap2" data-testid="timeline">
                {[...t.entries].reverse().slice(0, 8).map((e) => (
                  <li key={e.seq} className="row top gap3" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 8 }}>
                    <span className="tiny dim mono" style={{ minWidth: 92 }} title={formatUtc(e.at)}>
                      {formatAge(e.at)}
                    </span>
                    <div className="grow col gap1">
                      <span className="small strong">{e.summary}</span>
                      <span className="tiny dim mono">{e.type}</span>
                    </div>
                    <Badge outline>{e.actorKind}</Badge>
                  </li>
                ))}
              </ol>
            )
          }
        </Slot>
      </Card>

      {active && (
        <RunStrip label={active.questionSummary} detail={active.state.replace(/_/g, ' ').toLowerCase()} href={`/w/${wid}/runs/${active.runId}`} />
      )}
    </>
  );
}
