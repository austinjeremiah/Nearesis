'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice } from '@/components/nx/ui';
import { MutationError, ModeBadge, Slot } from '@/components/nx/research-kit';
import { RuleForm } from '@/components/nx/rule-form';
import { describe } from '@/components/nx/condition-editor';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { shellBrowser } from '@/lib/api/shell-browser';
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

  const markRead = useMutation({
    mutationFn: (which: { ids: string[] } | { all: true }) => shellBrowser.markWorkspaceNotificationsRead(wid, which),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notifications(wid) });
      void qc.invalidateQueries({ queryKey: ['global'] });
    },
  });
  const ruleNotifs = ((notifs.data as unknown as { notifications?: { notificationId: string; ruleId: string; title: string; body: string; mode: 'live' | 'replay'; createdAt: string; readAt: string | null }[] })?.notifications ?? []).filter((n) => n.ruleId === r.ruleId);
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
        <MutationError error={markRead.error} />
        {ruleNotifs.length === 0 ? (
          <div className="small dim">No notification yet.</div>
        ) : (
          <ul className="small" data-testid="rule-notifications">
            {ruleNotifs.map((n) => (
              <li key={n.notificationId}><ModeBadge mode={n.mode} /> <span className="strong">{n.title}</span> {n.body} <span className="tiny dim">{formatUtc(n.createdAt)}</span>{' '}
                {n.readAt ? <span className="tiny dim" data-testid="rule-notification-read">read</span> : <Button variant="ghost" data-testid="rule-mark-read" pending={markRead.isPending} onClick={() => markRead.mutate({ ids: [n.notificationId] })}>Mark read</Button>}
              </li>
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

function isoDay(offsetFromToday: number) {
  return new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + offsetFromToday * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Replay: evaluate this rule over RECORDED daily metric values of the live layer for a window of complete UTC days.
 * Nothing is typed in: the values come from the API's recorded history. Everything it writes is flagged replay, never
 * live, and a day without a recorded observation evaluates as no data.
 */
function ReplayCard({ wid, r }: { wid: string; r: MonitorRule }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(isoDay(-7));
  const [to, setTo] = useState(isoDay(-1));
  const run = useMutation({
    mutationFn: () => research.replayRule(wid, r.ruleId, { from, to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.monitors(wid) }),
  });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  return (
    <Card title="Replay over recorded history" subtitle="Evaluate this rule over the recorded daily metric values. Replay results are labelled replay everywhere.">
      <div className="col gap2" data-testid="replay-form">
        <Notice tone="info" title="Replay, not live">Values come from recorded history (complete UTC days, at most 90). They do not change live counters or evidence.</Notice>
        <div className="row gap2" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="From (UTC day)"><Input type="date" aria-label="Replay from" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To (UTC day)"><Input type="date" aria-label="Replay to" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Button variant="primary" disabled={!valid || !r.enabled} disabledReason={!r.enabled ? 'Enable the rule before replaying it.' : 'From must be on or before To.'} pending={run.isPending} onClick={() => run.mutate()} data-testid="run-replay">Run replay</Button>
        </div>
        <MutationError error={run.error} />
        {run.data && (
          <div className="col gap2" data-testid="replay-result" data-fired={run.data.fired}>
            <Notice tone="ok" title={`Replayed ${run.data.window.days} day(s): ${run.data.fired} fired`}>
              <Badge tone="warn">replay</Badge> {run.data.label}. Value source: {run.data.valueSource}.
            </Notice>
            <div className="rs-scroll">
              <table className="table">
                <thead><tr><th>Day</th><th>Mode</th><th>Recorded value</th><th>Outcome</th></tr></thead>
                <tbody>
                  {run.data.results.map((x) => (
                    <tr key={x.day} data-outcome={x.outcome}>
                      <td className="mono small">{x.day}</td>
                      <td><ModeBadge mode="replay" /></td>
                      <td className="small mono">{Object.entries(x.values).map(([k, v]) => `${k}=${v}`).join(', ')}{x.missing.length ? ` (no observation: ${x.missing.join(', ')})` : ''}</td>
                      <td><Badge tone={OUTCOME_TONE[x.outcome] ?? ''}>{x.outcome.replace(/_/g, ' ')}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
