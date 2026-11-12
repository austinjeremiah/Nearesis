'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, Field, KeyValues, Notice, Select } from '@/components/nx/ui';
import { MutationError, Slot, SUPPORT_TONE, UnknowableView } from '@/components/nx/research-kit';
import { Comments } from '../../evidence/evidence-view';
import { research, rk, type ClaimDetail } from '@/lib/research/api';
import { shortHash } from '@/lib/format';

export default function ClaimView({ wid, claimId }: { wid: string; claimId: string }) {
  const q = useQuery({ queryKey: rk.claim(wid, claimId), queryFn: () => research.claim(wid, claimId) });
  const title = q.data ? q.data.statement.slice(0, 90) + (q.data.statement.length > 90 ? '…' : '') : 'Claim';
  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: 'Evidence graph', href: `/w/${wid}/evidence` }, { label: 'Claim' }]}
        context={q.data ? <Badge tone={SUPPORT_TONE[q.data.support] ?? 'warn'}>{q.data.support}</Badge> : undefined}
      />
      <Content>
        <Slot q={q} rows={6}>{(c) => <Body wid={wid} c={c} />}</Slot>
      </Content>
    </>
  );
}

function Body({ wid, c }: { wid: string; c: ClaimDetail }) {
  return (
    <div className="col gap3" data-testid="claim-detail" data-claim-id={c.claimId}>
      <Card title="Statement">
        <p>{c.statement}</p>
        <div className="row gap2" style={{ flexWrap: 'wrap' }}>
          <Badge tone={SUPPORT_TONE[c.support] ?? 'warn'}>{c.support}</Badge>
          <Badge outline>verdict: {c.verdict}</Badge>
          <Badge outline>tier: {c.strength.evidenceTier}</Badge>
          {c.disputed && <Badge tone="bad">disputed</Badge>}
          {c.evidenceUnavailable && <Badge tone="bad">evidence unavailable</Badge>}
        </div>
        {c.missing.length > 0 && (
          <Notice tone="warn" title="Not publishable as supported: missing provenance">
            <span className="mono small">{c.missing.join(', ')}</span>
          </Notice>
        )}
      </Card>

      <div className="grid c2">
        <Card title="Estimate">
          <UnknowableView v={c.estimate} />
        </Card>
        <Card title="Strength of evidence">
          <KeyValues rows={[{ k: 'Evidence tier', v: c.strength.evidenceTier }]} />
          <div className="label">Linked research</div>
          <UnknowableView v={c.strength.research} />
        </Card>
        <Card title="Counterexamples">
          <UnknowableView v={c.counterexamples} />
        </Card>
        <Card title="Falsification criterion">
          <UnknowableView v={c.falsification} />
        </Card>
      </div>

      <Card title="Evidence">
        <div className="grid c2">
          <EvidenceList title="Supporting" items={c.evidence.supporting} wid={wid} />
          <EvidenceList title="Contradicting" items={c.evidence.contradicting} wid={wid} />
        </div>
        {c.evidence.provenance && (
          <div style={{ marginTop: 12 }}>
            <div className="label">Provenance (claim to query to snapshot)</div>
            <KeyValues
              rows={Object.entries(c.evidence.provenance).map(([k, v]) => ({
                k,
                v: <span className="mono small" style={{ wordBreak: 'break-all' }}>{Array.isArray(v) ? v.join(', ') : typeof v === 'string' && v.length > 40 ? shortHash(v, 14, 8) : String(v)}</span>,
              }))}
            />
          </div>
        )}
      </Card>

      <div className="grid c2">
        <Card title="Hypotheses">
          {c.hypotheses.length === 0 ? (
            <div className="small dim">No hypothesis is linked to this claim.</div>
          ) : (
            <ul className="small">
              {c.hypotheses.map((h) => (
                <li key={h.hypothesisId}>
                  <Link className="link" href={`/w/${wid}/hypotheses`}>{String(h.proposition ?? h.hypothesisId)}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Research runs">
          {c.research.length === 0 ? (
            <div className="small dim">No research run is linked.</div>
          ) : (
            <ul className="small">
              {c.research.map((r, i) => (
                <li key={i}>
                  {r.experimentId ? <Link className="link" href={`/w/${wid}/experiments/${r.experimentId}`}>{r.experimentId}</Link> : JSON.stringify(r)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <TierControl wid={wid} c={c} />
      <Card title="Review">
        <Comments wid={wid} nodeId={c.claimId} />
      </Card>
    </div>
  );
}

function EvidenceList({ title, items, wid }: { title: string; items: { nodeId: string; kind: string; label: string }[]; wid: string }) {
  return (
    <div>
      <div className="label">{title}</div>
      {items.length === 0 ? (
        <div className="small dim">None linked.</div>
      ) : (
        <ul className="small">
          {items.map((i) => (
            <li key={i.nodeId}>
              <Badge outline>{i.kind}</Badge> {i.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Tier control. Raising a claim to out_of_sample must rest on live evidence; the API refuses a memory basis
 * (MEMORY_CANNOT_UPGRADE_CONFIDENCE) and an upgrade without an out-of-sample statistical result. Those refusals
 * are shown as returned, never worked around.
 */
function TierControl({ wid, c }: { wid: string; c: ClaimDetail }) {
  const qc = useQueryClient();
  const g = useQuery({ queryKey: rk.graph(wid), queryFn: () => research.graph(wid) });
  const [tier, setTier] = useState<'exploratory' | 'out_of_sample'>(c.strength.evidenceTier === 'out_of_sample' ? 'exploratory' : 'out_of_sample');
  const [basisKind, setBasisKind] = useState<'evidence' | 'memory'>('evidence');
  const [nodeId, setNodeId] = useState('');
  const [summaryId, setSummaryId] = useState('');
  const results = (g.data?.nodes ?? []).filter((n) => n.type === 'statistical_result');
  const m = useMutation({
    mutationFn: () =>
      research.setClaimTier(wid, c.claimId, tier, basisKind === 'evidence' ? { kind: 'evidence', nodeIds: [nodeId] } : { kind: 'memory', summaryId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: rk.claim(wid, c.claimId) });
      void qc.invalidateQueries({ queryKey: rk.graph(wid) });
    },
  });
  const ready = basisKind === 'evidence' ? !!nodeId : !!summaryId;
  return (
    <Card title="Evidence tier" subtitle="Raising to out of sample needs a live out-of-sample statistical result. Memory or a summary can never raise it.">
      <div className="rs-form" data-testid="tier-control">
        <Field label="Move to">
          <Select aria-label="Target tier" value={tier} onChange={(e) => setTier(e.target.value as typeof tier)} options={[{ value: 'out_of_sample', label: 'out of sample' }, { value: 'exploratory', label: 'exploratory' }]} />
        </Field>
        <Field label="Basis">
          <Select aria-label="Basis kind" value={basisKind} onChange={(e) => setBasisKind(e.target.value as typeof basisKind)} options={[{ value: 'evidence', label: 'evidence (statistical result)' }, { value: 'memory', label: 'memory or summary' }]} />
        </Field>
        {basisKind === 'evidence' ? (
          <Field label="Statistical result" help={results.length === 0 ? 'No statistical result exists in this workspace.' : undefined}>
            <Select aria-label="Statistical result" value={nodeId} onChange={(e) => setNodeId(e.target.value)} options={[{ value: '', label: 'Select a result' }, ...results.map((r) => ({ value: r.id, label: r.label.slice(0, 70) }))]} />
          </Field>
        ) : (
          <Field label="Summary id">
            <input className="input" aria-label="Summary id" value={summaryId} onChange={(e) => setSummaryId(e.target.value)} placeholder="uuid" />
          </Field>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <Button variant="primary" disabled={!ready} disabledReason="Choose the evidence the change rests on." pending={m.isPending} onClick={() => m.mutate()} data-testid="apply-tier">
          Apply tier change
        </Button>
      </div>
      <MutationError error={m.error} />
      {m.isSuccess && <Notice tone="ok" title="Tier updated">The claim is now {tier.replace('_', ' ')}.</Notice>}
    </Card>
  );
}
