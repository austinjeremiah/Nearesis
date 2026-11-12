'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice } from '@/components/nx/ui';
import { MutationError, ModeBadge, Slot } from '@/components/nx/research-kit';
import { RuleForm } from '@/components/nx/rule-form';
import { describe, metricsIn } from '@/components/nx/condition-editor';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { research, rk, type MonitorRule } from '@/lib/research/api';
import { formatUtc } from '@/lib/format';

const OUTCOME_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | ''> = { fired: 'ok', condition_false: '', debounced: 'warn', cooldown: 'warn', frequency: 'warn', no_data: 'info', disabled: '' };

export default function RuleView({ wid, ruleId }: { wid: string; ruleId: string }) {
  const rules = useQuery({ queryKey: rk.rules(wid), queryFn: () => research.rules(wid) });
  const rule = rules.data?.rules.find((r) => r.ruleId === ruleId);
  return (
    <>
      <PageHeader
        title={rule?.name ?? 'Monitor rule'}
        crumbs={[{ label: 'Monitors', href: `/w/${wid}/monitors` }, { label: ruleId.slice(0, 8) }]}
        context={rule ? <Badge tone={rule.enabled ? 'ok' : ''}>{rule.enabled ? 'enabled' : 'disabled'}</Badge> : undefined}
      />
      <Content>
        <Slot q={rules} rows={4}>
          {(d) => {
            const r = d.rules.find((x) => x.ruleId === ruleId);
            return r ? <Body wid={wid} r={r} /> : <EmptyState title="Rule not found" body="It does not exist in this workspace." />;
          }}
        </Slot>
      </Content>
    </>
  );
}

function Body({ wid, r }: { wid: string; r: MonitorRule }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const triggers = useQuery({ queryKey: rk.triggers(wid, r.ruleId), queryFn: () => research.triggers(wid, r.ruleId), refetchInterval: 15_000 });
  const evals = useQuery({ queryKey: rk.evaluations(wid, r.ruleId), queryFn: () => research.evaluations(wid, r.ruleId) });
  const notifs = useQuery({ queryKey: qk.notifications(wid), queryFn: () => browserApi.notifications(wid) });
  const toggle = useMutation({ mutationFn: () => research.setRuleEnabled(wid, r.ruleId, !r.enabled), onSuccess: () => qc.invalidateQueries({ queryKey: qk.monitors(wid) }) });

  const ruleNotifs = ((notifs.data as unknown as { notifications?: { notificationId: string; ruleId: string; title: string; body: string; mode: 'live' | 'replay'; createdAt: string }[] })?.notifications ?? []).filter((n) => n.ruleId === r.ruleId);
  const trig = triggers.data?.triggers ?? [];
  const live = trig.filter((t) => t.mode === 'live');
  const replay = trig.filter((t) => t.mode === 'replay');

  return (
    <div className="col gap3" data-testid="rule-detail" data-enabled={r.enabled}>
      <Card
        title="Rule"
        actions={
          <div className="row gap2">
            <Button onClick={() => setEditing((e) => !e)} data-testid="edit-rule">{editing ? 'Close editor' : 'Edit'}</Button>
            <Button variant={r.enabled ? 'secondary' : 'primary'} pending={toggle.isPending} onClick={() => toggle.mutate()} data-testid="toggle-rule">{r.enabled ? 'Disable' : 'Enable'}</Button>
          </div>
        }
      >
        <KeyValues
          rows={[
            { k: 'Condition', v: <span className="mono small" data-testid="rule-condition">{describe(r.condition)}</span> },
            { k: 'Source', v: <span className="mono">{r.sourceId}</span> },
            { k: 'Action', v: r.action },
            { k: 'Data maturity', v: r.dataMaturity },
            { k: 'Frequency limit', v: `${r.frequency.minIntervalSeconds}s between evaluations` },
            { k: 'Debounce', v: `${r.debounceSeconds}s` },
            { k: 'Cooldown (dedupe window)', v: `${r.cooldownSeconds}s` },
            { k: 'Max runs per day', v: r.maxRunsPerDay ?? 'no cap' },
            { k: 'Marker', v: r.markerId ? <Link className="link" href={`/w/${wid}/markers/${r.markerId}`}>{r.markerId.slice(0, 8)}</Link> : 'none' },
            { k: 'Version', v: <span className="mono">{r.version}</span> },
            { k: 'Created', v: formatUtc(r.createdAt) },
          ]}
        />
        <MutationError error={toggle.error} />
      </Card>
      {editing && <RuleForm wid={wid} rule={r} onSaved={() => setEditing(false)} />}

      <div className="grid c2">
        <Card title="Live" subtitle="Evaluations driven by real source watermarks.">
          <Outcomes list={live} testid="live-counts" />
        </Card>
        <Card title="Replay" subtitle="Replayed events. Counted apart and never reported as live.">
          <Outcomes list={replay} testid="replay-counts" />
        </Card>
      </div>

      <Card title="Trigger history">
        <Slot q={triggers} rows={3}>
          {(d) =>
            d.triggers.length === 0 ? (
              <div className="small dim">This rule has not been evaluated yet.</div>
            ) : (
              <div className="rs-scroll">
                <table className="table" data-testid="triggers">
                  <thead><tr><th>Outcome</th><th>Mode</th><th>Watermark</th><th>Observed</th><th>Notification</th></tr></thead>
                  <tbody>
                    {d.triggers.map((t) => (
                      <tr key={t.triggerId} data-outcome={t.outcome} data-mode={t.mode}>
                        <td><Badge tone={OUTCOME_TONE[t.outcome] ?? ''}>{t.outcome.replace('_', ' ')}</Badge></td>
                        <td><ModeBadge mode={t.mode} /></td>
                        <td className="small mono">{formatUtc(t.watermark)}</td>
                        <td className="small mono">{Object.entries(t.observed).map(([k, v]) => `${k}=${v}`).join(', ')}</td>
                        <td className="small mono">{t.notificationId ? t.notificationId.slice(0, 8) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Slot>
      </Card>

      <Card title="Notifications from this rule" subtitle="New notifications arrive over the live event stream.">
        {ruleNotifs.length === 0 ? (
          <div className="small dim">No notification yet.</div>
        ) : (
          <ul className="small" data-testid="rule-notifications">
            {ruleNotifs.map((n) => (
              <li key={n.notificationId}><ModeBadge mode={n.mode} /> <span className="strong">{n.title}</span> {n.body} <span className="tiny dim">{formatUtc(n.createdAt)}</span></li>
            ))}
          </ul>
        )}
      </Card>

      <ReplayCard wid={wid} r={r} />

      <Card title="Evaluations" subtitle="Every watermark the rule saw, including not-final and skipped ones.">
        <Slot q={evals} rows={2}>
          {(d) =>
            d.evaluations.length === 0 ? (
              <div className="small dim">No evaluation recorded.</div>
            ) : (
              <div className="rs-scroll">
                <table className="table">
                  <thead><tr><th>Status</th><th>Mode</th><th>Watermark</th><th>Value</th></tr></thead>
                  <tbody>
                    {d.evaluations.slice(0, 100).map((e) => (
                      <tr key={e.evaluationId}>
                        <td>{e.status.replace(/_/g, ' ')}</td><td><ModeBadge mode={e.mode} /></td>
                        <td className="small mono">{formatUtc(e.watermark)}</td>
                        <td className="small mono">{JSON.stringify(e.evaluatedValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Slot>
      </Card>
    </div>
  );
}

function Outcomes({ list, testid }: { list: { outcome: string }[]; testid: string }) {
  const c = (l: { outcome: string }[], o: string) => l.filter((t) => t.outcome === o).length;
  const s = (l: { outcome: string }[]) => c(l, 'debounced') + c(l, 'cooldown') + c(l, 'frequency');
  return (
    <div data-testid={testid}>
      <KeyValues
        rows={[
          { k: 'Evaluations', v: <span className="mono" data-k="total">{list.length}</span> },
          { k: 'Fired', v: <span className="mono" data-k="fired">{c(list, 'fired')}</span> },
          { k: 'Suppressed (debounce, cooldown, frequency)', v: <span className="mono" data-k="suppressed">{s(list)}</span> },
          { k: 'Condition false', v: <span className="mono" data-k="false">{c(list, 'condition_false')}</span> },
        ]}
      />
    </div>
  );
}

/**
 * Replay: evaluate this rule against events you provide, flagged replay end to end. It never touches the live
 * counters or other rules. The values are entered by the person, so the result says what the rule WOULD do.
 */
function ReplayCard({ wid, r }: { wid: string; r: MonitorRule }) {
  const qc = useQueryClient();
  const metrics = metricsIn(r.condition);
  const [rows, setRows] = useState<{ at: string; values: Record<string, string> }[]>([{ at: '', values: {} }]);
  const run = useMutation({
    mutationFn: () =>
      research.replay(
        wid,
        r.sourceId,
        rows.map((x) => ({ watermark: new Date(x.at).toISOString(), values: Object.fromEntries(metrics.map((m) => [m, Number(x.values[m] ?? 0)])) })),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.monitors(wid) }),
  });
  const valid = rows.every((x) => x.at && metrics.every((m) => x.values[m] !== undefined && x.values[m] !== '' && !Number.isNaN(Number(x.values[m]))));
  return (
    <Card title="Replay events" subtitle="Test the rule against recorded or hypothetical watermarks. Replay results are labelled replay everywhere.">
      <div className="col gap2" data-testid="replay-form">
        <Notice tone="info" title="Replay, not live">Values you enter here are evaluated as replay events. They do not change live counters or evidence.</Notice>
        {rows.map((row, i) => (
          <div key={i} className="row gap2" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
            <Field label="Watermark (UTC)">
              <Input type="datetime-local" aria-label={`Replay watermark ${i + 1}`} value={row.at} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, at: e.target.value } : x)))} />
            </Field>
            {metrics.map((m) => (
              <Field key={m} label={m}>
                <Input type="number" aria-label={`Replay value ${m} ${i + 1}`} value={row.values[m] ?? ''} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, values: { ...x.values, [m]: e.target.value } } : x)))} />
              </Field>
            ))}
            {rows.length > 1 && <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>}
          </div>
        ))}
        <div className="row gap2">
          <Button onClick={() => setRows([...rows, { at: '', values: {} }])} disabled={rows.length >= 50} disabledReason="At most 50 events here.">Add event</Button>
          <Button variant="primary" disabled={!valid} disabledReason="Every event needs a time and a value per metric." pending={run.isPending} onClick={() => run.mutate()} data-testid="run-replay">Run replay</Button>
        </div>
        <MutationError error={run.error} />
        {run.data && <Notice tone="ok" title={`Replayed ${run.data.processed} event(s)`}>See the replay column above and the trigger history.</Notice>}
      </div>
    </Card>
  );
}
