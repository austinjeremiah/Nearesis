import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Card, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/**
 * Spec 5.21 — Time Machine.
 *
 * The important case is the honest one. When the raw input vintage for a past
 * revision is no longer available, the page says "historical view only,
 * calculations cannot be reproduced" rather than presenting the old conclusion
 * as if it could be rerun today.
 */
const REVISIONS = [
  { id: 'r12', at: '2026-11-09T19:00:00.000Z', label: 'Capsule 1.2.0 sealed', snapshot: 'snap_2026_11_09', rebuildable: true },
  { id: 'r11', at: '2026-11-09T14:10:00.000Z', label: 'Marker m1 created', snapshot: 'snap_2026_11_09', rebuildable: true },
  { id: 'r10', at: '2026-11-08T10:14:00.000Z', label: 'Four panels applied', snapshot: 'snap_2026_11_09', rebuildable: true },
  { id: 'r07', at: '2026-11-02T09:00:00.000Z', label: 'H1 preregistration frozen', snapshot: 'snap_2026_11_01', rebuildable: true },
  { id: 'r03', at: '2026-10-18T11:20:00.000Z', label: 'First draft canvas', snapshot: 'snap_2026_10_18', rebuildable: false },
];

export default async function TimeMachinePage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();

  return (
    <>
      <PageHeader
        title="Time machine"
        description="Reconstruct an earlier state of this workspace, with the data vintage it actually used."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Time machine' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <Notice tone="info" title="Two different things you can do here">
          Viewing an old revision shows what the workspace looked like. Rebuilding it recomputes
          the numbers from the raw snapshot that revision used. The second is only possible while
          that vintage is retained, and the list below says which is which.
        </Notice>

        <Card title="Revisions">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>At (UTC)</th>
                  <th>Change</th>
                  <th>Data vintage</th>
                  <th>Reproducible</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {REVISIONS.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono small">{formatUtc(r.at)}</td>
                    <td className="small">{r.label}</td>
                    <td className="mono small">{r.snapshot}</td>
                    <td>
                      {r.rebuildable ? (
                        <Badge tone="ok">Rebuildable</Badge>
                      ) : (
                        <Badge tone="warn" title="The raw input vintage for this revision is no longer retained.">
                          View only
                        </Badge>
                      )}
                    </td>
                    <td className="actions">
                      <Button disabled disabledReason="Opening a historical revision needs the authorized API.">
                        {r.rebuildable ? 'Open and rebuild' : 'Open view only'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Historical view only" subtitle="What r03 can and cannot tell you.">
          <KeyValues
            rows={[
              { k: 'State', v: 'Panel layout, notes and agent decisions are retained in full.' },
              { k: 'Numbers', v: 'The chart values as they were rendered then.' },
              {
                k: 'What is missing',
                v: 'The raw snapshot snap_2026_10_18 has aged out of retention, so the figures cannot be recomputed from source.',
              },
              {
                k: 'What that means',
                v: 'You can read what was concluded and why. You cannot independently verify it today.',
              },
            ]}
          />
          <Notice tone="warn" title="Historical view only; calculations cannot be reproduced">
            Showing this revision without that caveat would present an unverifiable conclusion as a
            checked one.
          </Notice>
          <Link className="link small" href={`/w/${wid}/capsules`}>
            Capsules retain their own raw data
          </Link>
        </Card>
      </Content>
    </>
  );
}
