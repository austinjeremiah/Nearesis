'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Notice } from '@/components/nx/ui';
import { DataTable, type Column } from '@/components/nx/table';
import { Slot } from '@/components/nx/research-kit';
import { IntegrityBadge, VerdictBadge } from '@/components/nx/experiment-parts';
import { research, rk, type Experiment } from '@/lib/research/api';

export default function ExperimentsView({ wid }: { wid: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: rk.experiments(wid), queryFn: () => research.experiments(wid) });
  const cols: Column<Experiment>[] = [
    { key: 'name', header: 'Experiment', width: '30%', render: (e) => <div className="col gap1"><span className="strong">{e.name}</span><span className="tiny mono dim">{e.experimentId}</span></div> },
    { key: 'verdict', header: 'Verdict', render: (e) => (e.integrity === 'verified' ? <VerdictBadge status={e.status} /> : <span className="dim small">not shown</span>) },
    { key: 'strength', header: 'Evidence', render: (e) => <Badge outline>{e.evidenceStrength}</Badge> },
    { key: 'val', header: 'Method', render: (e) => <Badge tone={e.methodValidated ? 'ok' : 'warn'}>{e.methodValidated ? 'validated' : 'not validated'}</Badge> },
    { key: 'origins', header: 'Origins', numeric: true, render: (e) => <span className="mono">{e.origins}</span> },
    { key: 'int', header: 'Integrity', render: (e) => <IntegrityBadge e={e} /> },
  ];
  return (
    <>
      <PageHeader title="Experiments" description="Pre-registered research runs and what they found. Read from verified run artifacts; nothing is computed in the browser." />
      <Content>
        <div className="col gap3">
          <Slot q={q} rows={4}>
            {(d) => (
              <>
                <Notice tone="info" title="Scope">{d.scope === 'platform_research_runs' ? 'These are the platform’s research runs, shared across workspaces. Link one to a hypothesis from the Hypotheses page.' : d.scope}</Notice>
                <DataTable caption="Experiments" columns={cols} rows={d.experiments} rowKey={(e) => e.experimentId} onRowClick={(e) => router.push(`/w/${wid}/experiments/${e.experimentId}`)} empty={{ title: 'No research runs', body: 'No verified research run is available to this deployment.' }} />
              </>
            )}
          </Slot>
        </div>
      </Content>
    </>
  );
}
