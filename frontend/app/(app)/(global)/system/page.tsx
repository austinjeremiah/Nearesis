import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, CoverageChip, DataModeIndicator, SourceHealthChip } from '@/components/nx/evidence';
import { Card, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatAge, formatUtc } from '@/lib/format';

/** Spec 5.30 — System Health, the user-facing one, not the internal build monitor. */
export default function SystemHealthPage() {
  const sources = db.sources();
  const degraded = sources.filter((s) => s.health !== 'healthy');

  return (
    <>
      <PageHeader
        title="System health"
        description="Source and service state, scoped to what you are permitted to see."
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <Notice tone="warn" title="This instance is not connected to a backend">
          Service checks below report the frontend's own state. Source rows come from the frozen
          fixture snapshot, so they show what the UI does with each condition rather than live
          provider health.
        </Notice>

        <Card title="Sources">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Last finalized</th>
                  <th>Coverage</th>
                  <th>Rate limit</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link className="link" href={`/data/sources/${s.id}`}>
                        {s.name}
                      </Link>
                    </td>
                    <td>
                      <SourceHealthChip health={s.health} />
                    </td>
                    <td className="mono small" title={formatUtc(s.watermark)}>
                      {formatAge(s.watermark)}
                    </td>
                    <td>
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
                    </td>
                    <td className="small">{s.rateLimit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Services">
            <KeyValues
              rows={[
                { k: 'Web application', v: <Badge tone="ok">Operational</Badge> },
                { k: 'API', v: <Badge tone="warn">Not connected</Badge> },
                { k: 'Event stream (SSE)', v: <Badge tone="warn">Not connected</Badge> },
                { k: 'Workflow engine', v: <Badge tone="warn">Not connected</Badge> },
                { k: 'Semantic layer', v: <Badge tone="warn">Not connected</Badge> },
              ]}
            />
            <p className="tiny dim">
              Not connected is reported as its own state, distinct from degraded. An unbuilt
              service is not a failing one.
            </p>
          </Card>

          <Card title="Open incidents">
            {degraded.length === 0 ? (
              <p className="small muted">No source is currently degraded.</p>
            ) : (
              <div className="col gap3">
                {degraded.map((s) => (
                  <div key={s.id} className="col gap1" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 10 }}>
                    <div className="row gap2">
                      <SourceHealthChip health={s.health} />
                      <Link className="link small strong" href={`/data/sources/${s.id}`}>
                        {s.name}
                      </Link>
                    </div>
                    {s.error ? (
                      <>
                        <span className="tiny mono dim">{s.error.code}</span>
                        <span className="tiny dim">{s.error.message}</span>
                        <span className="tiny dim mono">First seen {formatUtc(s.error.firstSeen)}</span>
                      </>
                    ) : (
                      <span className="tiny dim">{s.note}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </Content>
    </>
  );
}
