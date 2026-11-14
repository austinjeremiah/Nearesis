'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, KeyValues } from '@/components/nx/ui';
import { DataTable, type Column } from '@/components/nx/table';
import { MutationError, Slot } from '@/components/nx/research-kit';
import { RuleForm } from '@/components/nx/rule-form';
import { describe } from '@/components/nx/condition-editor';
import { research, rk, type MonitorRule } from '@/lib/research/api';
import { qk } from '@/lib/api/keys';
import { formatAge, formatUtc } from '@/lib/format';

export default function MonitorsView({ wid }: { wid: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const rules = useQuery({ queryKey: rk.rules(wid), queryFn: () => research.rules(wid) });
  const counters = useQuery({ queryKey: rk.counters(wid), queryFn: () => research.counters(wid) });
  const marks = useQuery({ queryKey: rk.watermarks(wid), queryFn: () => research.watermarks(wid) });
  const toggle = useMutation({
    mutationFn: (r: MonitorRule) => research.setRuleEnabled(wid, r.ruleId, !r.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.monitors(wid) }),
  });

  const cols: Column<MonitorRule>[] = [
    { key: 'name', header: 'Rule', width: '26%', render: (r) => <span className="strong">{r.name}</span> },
    { key: 'cond', header: 'Condition', width: '30%', render: (r) => <span className="small mono">{describe(r.condition)}</span> },
    { key: 'src', header: 'Source', render: (r) => <span className="small mono">{r.sourceId}</span> },
    { key: 'win', header: 'Cooldown / debounce', render: (r) => <span className="small mono">{r.cooldownSeconds}s / {r.debounceSeconds}s</span> },
    { key: 'en', header: 'State', render: (r) => <Badge tone={r.enabled ? 'ok' : ''}>{r.enabled ? 'enabled' : 'disabled'}</Badge> },
    {
      key: 'toggle',
      header: '',
      render: (r) => (
        <Button onClick={(e) => { e.stopPropagation(); toggle.mutate(r); }} pending={toggle.isPending && toggle.variables?.ruleId === r.ruleId} data-testid={`toggle-${r.ruleId}`}>
          {r.enabled ? 'Disable' : 'Enable'}
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title="Monitors"
        description="Rules that watch source watermarks. Live evaluations and replays are counted separately and never mixed."
        actions={<Button variant="primary" onClick={() => setCreating((c) => !c)} data-testid="new-rule">{creating ? 'Close' : 'New rule'}</Button>}
      />
      <Content>
        <div className="col gap3">
          {creating && <RuleForm wid={wid} onSaved={(id) => router.push(`/w/${wid}/monitors/${id}`)} />}
          <div className="grid c2">
            <Card title="Evaluations today (UTC)">
              <Slot q={counters} rows={1}>
                {(c) => (
                  <KeyValues rows={[
                    { k: 'Day', v: <span className="mono">{c.day}</span> },
                    { k: 'Live', v: <span className="mono" data-testid="counter-live">{c.live}</span> },
                    { k: 'Replay', v: <span className="mono" data-testid="counter-replay">{c.replay}</span> },
                  ]} />
                )}
              </Slot>
            </Card>
            <Card title="Source watermarks">
              <Slot q={marks} rows={1}>
                {(d) =>
                  d.watermarks.length === 0 ? (
                    <div className="small dim">No rule has seen a watermark yet.</div>
                  ) : (
                    <KeyValues rows={d.watermarks.map((w) => ({ k: w.sourceId, v: <span className="small mono">{formatUtc(w.watermark)} ({formatAge(w.watermark)})</span> }))} />
                  )
                }
              </Slot>
            </Card>
          </div>
          <MutationError error={toggle.error} />
          <Slot q={rules} rows={4}>
            {(d) => (
              <DataTable
                caption="Monitor rules"
                columns={cols}
                rows={d.rules}
                rowKey={(r) => r.ruleId}
                onRowClick={(r) => router.push(`/w/${wid}/monitors/${r.ruleId}`)}
                empty={{ title: 'No monitor rules', body: 'Create a rule to be notified when a metric crosses a condition.' }}
              />
            )}
          </Slot>
        </div>
      </Content>
    </>
  );
}
