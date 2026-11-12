'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, Field, Input, KeyValues, Notice, Select, Textarea } from '@/components/nx/ui';
import { MarkerStatusBadge, ModeBadge, MutationError, Slot } from '@/components/nx/research-kit';
import { AGENT_ROLES } from '@/components/nx/marker-create';
import { anchorText } from '../markers-view';
import { research, rk, type Marker } from '@/lib/research/api';
import { qk } from '@/lib/api/keys';
import { formatUtc, shortHash } from '@/lib/format';

const NEXT: Record<string, string[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['INVESTIGATING'],
  INVESTIGATING: ['REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['RESOLVED', 'MONITORING', 'DISMISSED'],
  RESOLVED: [],
  MONITORING: [],
  DISMISSED: [],
};

export default function MarkerView({ wid, markerId }: { wid: string; markerId: string }) {
  const q = useQuery({ queryKey: rk.marker(wid, markerId), queryFn: () => research.marker(wid, markerId), refetchInterval: 10_000 });
  return (
    <>
      <PageHeader
        title={q.data?.question ?? 'Marker'}
        crumbs={[{ label: 'Markers', href: `/w/${wid}/markers` }, { label: markerId.slice(0, 8) }]}
        context={q.data ? <><MarkerStatusBadge status={q.data.status} /><ModeBadge mode={q.data.mode} /></> : undefined}
      />
      <Content>
        <Slot q={q} rows={5}>{(m) => <Body wid={wid} m={m} />}</Slot>
      </Content>
    </>
  );
}

function Body({ wid, m }: { wid: string; m: Marker }) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.markers(wid) });
    void qc.invalidateQueries({ queryKey: rk.graph(wid) });
  };
  const tasks = useQuery({ queryKey: rk.markerTasks(wid, m.markerId), queryFn: () => research.markerTasks(wid, m.markerId), refetchInterval: 8_000 });
  const deleg = useQuery({ queryKey: rk.markerDelegations(wid, m.markerId), queryFn: () => research.markerDelegations(wid, m.markerId) });
  const graph = useQuery({ queryKey: rk.graph(wid), queryFn: () => research.graph(wid) });

  const [agent, setAgent] = useState<string>('quant');
  const [resolution, setResolution] = useState('');
  const [evidenceId, setEvidenceId] = useState('');

  const assign = useMutation({ mutationFn: () => research.assignMarker(wid, m.markerId, [agent]), onSuccess: () => { refresh(); void tasks.refetch(); void deleg.refetch(); } });
  const transition = useMutation({ mutationFn: (to: string) => research.transitionMarker(wid, m.markerId, to, resolution.trim() || undefined), onSuccess: refresh });
  const link = useMutation({ mutationFn: () => research.linkEvidence(wid, m.markerId, [evidenceId]), onSuccess: () => { setEvidenceId(''); refresh(); } });

  const next = NEXT[m.status] ?? [];
  const needsResolution = next.some((s) => ['RESOLVED', 'MONITORING', 'DISMISSED'].includes(s));
  const evidenceChoices = (graph.data?.nodes ?? []).filter((n) => ['claim', 'statistical_result', 'observation', 'query'].includes(n.type) && !m.linkedEvidenceIds.includes(n.id));
  const canAssign = m.status === 'ACTIVE' || m.status === 'INVESTIGATING';

  return (
    <div className="col gap3" data-testid="marker-detail" data-status={m.status}>
      {m.reasonCode && (
        <Notice tone="warn" title="The latest agent task did not succeed">
          <span className="mono small">{m.reasonCode}</span>
        </Notice>
      )}
      <div className="grid c2">
        <Card title="Anchor">
          <KeyValues
            rows={[
              { k: 'Kind', v: m.anchorType.replace('_', ' ') },
              { k: 'Where', v: anchorText(m) },
              { k: 'Panel', v: <Link className="link" href={`/w/${wid}/panels/${m.sourcePanelId}`}>{m.sourcePanelId.slice(0, 8)}</Link> },
              { k: 'Canvas revision', v: <span className="mono">{m.sourceVersion}</span> },
              { k: 'Created', v: formatUtc(m.timestamp) },
              { k: 'Version', v: <span className="mono">{m.version}</span> },
            ]}
          />
        </Card>
        <Card title="Selection context">
          {m.selection ? (
            <KeyValues
              rows={[
                { k: 'Query', v: <span className="mono small" title={m.selection.queryHash}>{shortHash(m.selection.queryHash, 12, 6)}</span> },
                { k: 'Semantic version', v: m.selection.semanticVersion },
                { k: 'Interval', v: `${formatUtc(m.selection.interval.start, false)} to ${formatUtc(m.selection.interval.end, false)}` },
                { k: 'Series', v: m.selection.seriesIds.join(', ') || '—' },
                { k: 'Source watermark', v: formatUtc(m.selection.sourceWatermark) },
              ]}
            />
          ) : (
            <div className="small dim">This marker was not created from a chart selection, so no query context was captured.</div>
          )}
        </Card>
      </div>

      <Card title="Status" subtitle="DRAFT, ACTIVE, INVESTIGATING, REVIEW REQUIRED, then RESOLVED, MONITORING or DISMISSED. Each step is one transition.">
        <div className="col gap2">
          {m.resolution && <div className="small"><span className="label">Resolution</span> {m.resolution}</div>}
          {next.length === 0 ? (
            <div className="small dim">This marker is in a final state.</div>
          ) : (
            <>
              {needsResolution && (
                <Field label="Resolution note">
                  <Textarea rows={2} aria-label="Resolution note" value={resolution} onChange={(e) => setResolution(e.target.value)} />
                </Field>
              )}
              <div className="row gap2" style={{ flexWrap: 'wrap' }}>
                {next.map((to) => (
                  <Button key={to} variant="primary" pending={transition.isPending} onClick={() => transition.mutate(to)} data-testid={`to-${to}`}
                    disabled={needsResolution && !resolution.trim()} disabledReason="A resolution note is required to close the review.">
                    Move to {to.replace(/_/g, ' ').toLowerCase()}
                  </Button>
                ))}
              </div>
            </>
          )}
          <MutationError error={transition.error} />
        </div>
      </Card>

      <Card title="Sub-agent runs" subtitle="Assigning an agent starts a real investigation run under this marker, inside your delegation scope.">
        <div className="col gap2">
          <div className="row gap2" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
            <Field label="Agent">
              <Select aria-label="Agent role" value={agent} onChange={(e) => setAgent(e.target.value)} options={AGENT_ROLES.map((a) => ({ value: a, label: a.replace('_', ' ') }))} />
            </Field>
            <Button variant="primary" disabled={!canAssign} disabledReason="Move the marker to ACTIVE before assigning an agent." pending={assign.isPending} onClick={() => assign.mutate()} data-testid="assign-agent">
              Assign agent
            </Button>
          </div>
          <MutationError error={assign.error} />
          <Slot q={tasks} rows={1}>
            {(d) =>
              d.tasks.length === 0 ? (
                <div className="small dim">No agent task yet.</div>
              ) : (
                <table className="table" data-testid="marker-tasks">
                  <thead><tr><th>Status</th><th>Agents</th><th>Origin</th><th>Mode</th><th>Run</th><th>Created</th></tr></thead>
                  <tbody>
                    {d.tasks.map((t) => (
                      <tr key={t.taskId}>
                        <td><Badge tone={t.status === 'COMPLETE' ? 'ok' : t.status === 'FAILED' ? 'bad' : 'info'}>{t.status.toLowerCase()}</Badge>{t.reasonCode && <div className="tiny mono">{t.reasonCode}</div>}</td>
                        <td>{t.agents.join(', ')}</td>
                        <td>{t.origin}</td>
                        <td><ModeBadge mode={t.mode} /></td>
                        <td>{t.runId ? <Link className="link" href={`/w/${wid}/runs/${t.runId}`}>open run</Link> : '—'}</td>
                        <td className="small mono">{formatUtc(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </Slot>
          <Slot q={deleg} rows={1}>
            {(d) =>
              d.delegations.length > 0 ? (
                <div>
                  <div className="label">Delegation chain</div>
                  <ul className="small">
                    {d.delegations.map((x) => (
                      <li key={x.delegationId}>depth {x.depth}: {x.agents.join(', ')} {x.grants.length ? `(grants: ${x.grants.join(', ')})` : '(no extra grants)'}</li>
                    ))}
                  </ul>
                </div>
              ) : null
            }
          </Slot>
        </div>
      </Card>

      <Card title="Attached evidence" subtitle="Link claims, results or queries that bear on this marker.">
        <div className="col gap2">
          {m.linkedEvidenceIds.length === 0 ? (
            <div className="small dim">No evidence attached.</div>
          ) : (
            <ul className="small" data-testid="linked-evidence">
              {m.linkedEvidenceIds.map((id) => {
                const n = graph.data?.nodes.find((x) => x.id === id);
                return (
                  <li key={id}>
                    {n ? <><Badge outline>{n.type}</Badge> {n.label.slice(0, 120)}</> : <span className="mono">{id}</span>}{' '}
                    {n?.type === 'claim' && <Link className="link" href={`/w/${wid}/claims/${id}`}>open</Link>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="row gap2" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
            <Field label="Evidence node">
              <Select aria-label="Evidence node" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} options={[{ value: '', label: evidenceChoices.length ? 'Select evidence' : 'No evidence available' }, ...evidenceChoices.map((n) => ({ value: n.id, label: `${n.type}: ${n.label.slice(0, 60)}` }))]} />
            </Field>
            <Button disabled={!evidenceId} disabledReason="Select evidence to attach." pending={link.isPending} onClick={() => link.mutate()} data-testid="attach-evidence">Attach</Button>
          </div>
          <MutationError error={link.error} />
        </div>
      </Card>

      {m.monitorRuleId && (
        <Card title="Monitor">
          <Link className="link" href={`/w/${wid}/monitors/${m.monitorRuleId}`}>Open the rule watching this marker</Link>
        </Card>
      )}
    </div>
  );
}
