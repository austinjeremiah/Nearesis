'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { Button, EmptyState, Tabs } from '@/components/nx/ui';
import { Drawer } from '@/components/nx/overlays';
import { MarkerStatusBadge, MutationError, Slot } from '@/components/nx/research-kit';
import { RunStateChip } from '@/components/nx/run-parts';
import { ApprovalsView } from '@/components/nx/investigate-lists';
import { describe } from '@/components/nx/condition-editor';
import { PublicationBadge } from '@/components/ws6/capsule-bits';
import { anchorText } from '@/app/(app)/w/[wid]/markers/markers-view';
import { qk } from '@/lib/api/keys';
import { ApiRequestError } from '@/lib/api/errors';
import { investigateApi } from '@/lib/investigate/api';
import { research, rk, type MonitorRule } from '@/lib/research/api';
import { caps, type ProofSummary } from '@/lib/agent/ws-api';
import { formatAge } from '@/lib/format';

export type ManageTab = 'runs' | 'approvals' | 'monitors' | 'hypotheses' | 'markers' | 'capsules';
const TABS: { value: ManageTab; label: string }[] = [
  { value: 'runs', label: 'Runs' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'monitors', label: 'Monitors' },
  { value: 'hypotheses', label: 'Hypotheses' },
  { value: 'markers', label: 'Markers' },
  { value: 'capsules', label: 'Capsules' },
];

/** Cancel with the run's current version; a stale version is retried once with the fresh one. */
async function cancelRun(runId: string) {
  const v = (await investigateApi.run(runId)).version;
  try {
    await investigateApi.cancel(runId, v);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 409) await investigateApi.cancel(runId, (await investigateApi.run(runId)).version);
    else throw e;
  }
}

function Runs({ wid, onShowRun }: { wid: string; onShowRun: (runId: string, question: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.runs(wid), queryFn: () => investigateApi.runs(wid), refetchInterval: 10_000 });
  const cancel = useMutation({ mutationFn: cancelRun, onSettled: () => void qc.invalidateQueries({ queryKey: ['ws', wid] }) });
  return (
    <Slot q={q} rows={4}>
      {(d) =>
        d.runs.length === 0 ? (
          <EmptyState title="No runs yet" body="Use Ask in this workspace to start an investigation." />
        ) : (
          <ul className="ag-mlist" data-testid="manage-runs">
            {d.runs.map((r) => (
              <li key={r.runId}>
                <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
                  <RunStateChip state={r.state} />
                  <span className="tiny dim mono">{formatAge(r.startedAt)}</span>
                  <span className="grow" />
                  <Button onClick={() => onShowRun(r.runId, r.questionSummary)}>Show in chat</Button>
                  {!r.terminal && <Button variant="danger" pending={cancel.isPending && cancel.variables === r.runId} onClick={() => cancel.mutate(r.runId)}>Cancel</Button>}
                </div>
                <Link className="link small" href={`/w/${wid}/runs/${r.runId}`}>{r.questionSummary || r.runId.slice(0, 8)}</Link>
              </li>
            ))}
            <li><MutationError error={cancel.error} /></li>
          </ul>
        )
      }
    </Slot>
  );
}

function Monitors({ wid }: { wid: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: rk.rules(wid), queryFn: () => research.rules(wid) });
  const toggle = useMutation({ mutationFn: (r: MonitorRule) => research.setRuleEnabled(wid, r.ruleId, !r.enabled), onSuccess: () => qc.invalidateQueries({ queryKey: qk.monitors(wid) }) });
  return (
    <>
      <Slot q={q} rows={3}>
        {(d) =>
          d.rules.length === 0 ? (
            <EmptyState title="No monitor rules" body="Ask the agent to set up monitors, or create one on the Monitors page." />
          ) : (
            <ul className="ag-mlist" data-testid="manage-monitors">
              {d.rules.map((r) => (
                <li key={r.ruleId}>
                  <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
                    <Link className="link strong small" href={`/w/${wid}/monitors/${r.ruleId}`}>{r.name}</Link>
                    <Badge tone={r.enabled ? 'ok' : ''}>{r.enabled ? 'enabled' : 'disabled'}</Badge>
                    <span className="grow" />
                    <Button onClick={() => toggle.mutate(r)} pending={toggle.isPending && toggle.variables?.ruleId === r.ruleId}>{r.enabled ? 'Disable' : 'Enable'}</Button>
                  </div>
                  <span className="tiny mono dim">{describe(r.condition)}</span>
                </li>
              ))}
            </ul>
          )
        }
      </Slot>
      <MutationError error={toggle.error} />
    </>
  );
}

function Hypotheses({ wid }: { wid: string }) {
  const q = useQuery({ queryKey: rk.hypotheses(wid), queryFn: () => research.hypotheses(wid) });
  return (
    <Slot q={q} rows={3}>
      {(d) =>
        d.hypotheses.length === 0 ? (
          <EmptyState title="No hypotheses yet" body="A hypothesis is registered before the test. Ask the agent to draft one." />
        ) : (
          <ul className="ag-mlist" data-testid="manage-hypotheses">
            {d.hypotheses.map((h) => (
              <li key={h.hypothesisId}>
                <div className="row gap2 wrap">
                  <Badge tone={h.status === 'frozen' ? 'ok' : 'info'}>{h.status}</Badge>
                  {h.registered && <Badge outline>registered</Badge>}
                </div>
                <span className="small" style={{ overflowWrap: 'anywhere' }}>{h.proposition}</span>
                <span className="tiny dim" style={{ overflowWrap: 'anywhere' }}>Falsified if: {h.falsification}</span>
              </li>
            ))}
            <li><Link className="link small" href={`/w/${wid}/hypotheses`}>Open hypotheses</Link></li>
          </ul>
        )
      }
    </Slot>
  );
}

function Markers({ wid }: { wid: string }) {
  const q = useQuery({ queryKey: [...qk.markers(wid), 'list'], queryFn: () => research.markers(wid) });
  return (
    <Slot q={q} rows={3}>
      {(d) =>
        d.markers.length === 0 ? (
          <EmptyState title="No markers yet" body="Markers are questions anchored to a place on a panel." />
        ) : (
          <ul className="ag-mlist" data-testid="manage-markers">
            {d.markers.map((m) => (
              <li key={m.markerId}>
                <div className="row gap2 wrap"><MarkerStatusBadge status={m.status} /><span className="tiny mono dim">{anchorText(m)}</span></div>
                <Link className="link small" href={`/w/${wid}/markers/${m.markerId}`}>{m.question ?? 'No question'}</Link>
              </li>
            ))}
          </ul>
        )
      }
    </Slot>
  );
}

function ProofBadge({ p }: { p: ProofSummary | null | undefined }) {
  if (p === undefined) return <Badge outline>proof: loading</Badge>;
  if (p === null) return <Badge outline>no proof yet</Badge>;
  const tone = p.state === 'verified' ? 'ok' : p.state === 'failed' ? 'bad' : p.state === 'running' ? 'info' : 'warn';
  return <Badge tone={tone}>{p.state === 'verified' ? 'attested' : p.state.replace('_', ' ')}</Badge>;
}

function Capsules({ wid }: { wid: string }) {
  const q = useQuery({ queryKey: ['capsule-publications'], queryFn: () => caps.publications() });
  const rows = (q.data?.publications ?? []).filter((p) => p.workspaceId === wid);
  const proofs = useQueries({ queries: rows.map((r) => ({ queryKey: ['agent', 'proof', r.capsuleId], queryFn: () => caps.latestProof(r.capsuleId), retry: false })) });
  return (
    <Slot q={q} rows={3}>
      {() =>
        rows.length === 0 ? (
          <EmptyState title="No capsules for this workspace" body="Ask the agent to build, prove or publish a capsule from a finished run." />
        ) : (
          <ul className="ag-mlist" data-testid="manage-capsules">
            {rows.map((r, i) => (
              <li key={r.capsuleId}>
                <Link className="link strong small" href={`/w/${wid}/capsules/${encodeURIComponent(r.capsuleId)}`}>{r.title}</Link>
                <div className="row gap2 wrap">
                  <PublicationBadge state={r.state} />
                  <ProofBadge p={proofs[i]?.isError ? null : proofs[i]?.data} />
                  <Badge outline>{r.label}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )
      }
    </Slot>
  );
}

/** The selected workspace's runs, approvals, monitors, hypotheses, markers and capsules, without leaving the Agent tab. */
export default function WsManage({ open, onOpenChange, wid, objective, onShowRun }: { open: boolean; onOpenChange: (v: boolean) => void; wid: string; objective: string | null; onShowRun: (runId: string, question: string) => void }) {
  const [tab, setTab] = useState<ManageTab>('runs');
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Manage workspace">
      <div className="col gap3" data-testid="ws-manage">
        {objective && <p className="small dim" style={{ margin: 0, overflowWrap: 'anywhere' }}>{objective}</p>}
        <Tabs ariaLabel="Workspace sections" value={tab} onChange={setTab} options={TABS} />
        <div role="tabpanel" aria-label={tab}>
          {tab === 'runs' && <Runs wid={wid} onShowRun={(id, q) => (onShowRun(id, q), onOpenChange(false))} />}
          {tab === 'approvals' && <ApprovalsView wid={wid} />}
          {tab === 'monitors' && <Monitors wid={wid} />}
          {tab === 'hypotheses' && <Hypotheses wid={wid} />}
          {tab === 'markers' && <Markers wid={wid} />}
          {tab === 'capsules' && <Capsules wid={wid} />}
        </div>
      </div>
    </Drawer>
  );
}
