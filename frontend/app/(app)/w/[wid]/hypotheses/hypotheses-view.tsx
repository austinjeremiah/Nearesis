'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice, Select, Textarea } from '@/components/nx/ui';
import { MutationError, Slot } from '@/components/nx/research-kit';
import { research, rk, type Hypothesis, type HypothesisDetail } from '@/lib/research/api';
import { formatUtc, shortHash } from '@/lib/format';

type Draft = { proposition: string; target: string; predictor: string; benchmark: string; falsification: string };
const EMPTY: Draft = { proposition: '', target: '', predictor: '', benchmark: '', falsification: '' };

function HypothesisFields({ d, set, disabled }: { d: Draft; set: (d: Draft) => void; disabled?: boolean }) {
  const f = (k: keyof Draft, label: string, rows = 2, help?: string) => (
    <Field label={label} help={help} required={k === 'proposition' || k === 'falsification'}>
      <Textarea rows={rows} aria-label={label} disabled={disabled} value={d[k]} onChange={(e) => set({ ...d, [k]: e.target.value })} />
    </Field>
  );
  return (
    <div className="rs-form">
      <div className="wide">{f('proposition', 'Proposition', 3)}</div>
      {f('target', 'Target', 2, 'What is predicted or measured.')}
      {f('predictor', 'Predictor', 2, 'The signal expected to explain it.')}
      {f('benchmark', 'Benchmark', 2, 'What it must beat.')}
      <div className="wide">{f('falsification', 'Falsification criterion', 2, 'What result would show the hypothesis is wrong.')}</div>
    </div>
  );
}

export default function HypothesesView({ wid }: { wid: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: rk.hypotheses(wid), queryFn: () => research.hypotheses(wid) });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const create = useMutation({
    mutationFn: () => research.createHypothesis(wid, draft),
    onSuccess: (h) => {
      setDraft(EMPTY);
      setCreating(false);
      setSelected(h.hypothesisId);
      void qc.invalidateQueries({ queryKey: rk.hypotheses(wid) });
    },
  });
  const valid = draft.proposition.trim().length >= 5 && draft.falsification.trim().length >= 1;
  return (
    <>
      <PageHeader
        title="Hypotheses"
        description="State what you expect and what would prove you wrong before looking. A frozen hypothesis is immutable; changes are recorded as hashed amendments."
        actions={<Button variant="primary" onClick={() => setCreating((c) => !c)} data-testid="new-hypothesis">{creating ? 'Close' : 'New hypothesis'}</Button>}
      />
      <Content>
        <div className="col gap3">
          {creating && (
            <Card title="New hypothesis" subtitle="It starts as a draft you can edit. Freezing it records a content hash and a timestamp.">
              <HypothesisFields d={draft} set={setDraft} />
              <div style={{ marginTop: 12 }}>
                <Button variant="primary" disabled={!valid} disabledReason="A proposition (5+ characters) and a falsification criterion are required." pending={create.isPending} onClick={() => create.mutate()} data-testid="create-hypothesis">Create draft</Button>
              </div>
              <MutationError error={create.error} />
            </Card>
          )}
          <Slot q={q} rows={4}>
            {(d) =>
              d.hypotheses.length === 0 ? (
                <EmptyState title="No hypotheses yet" body="Write one before running an experiment, so the test is registered before the result is known." />
              ) : (
                <div className="grid c2" style={{ alignItems: 'start' }}>
                  <div className="col gap2" data-testid="hypothesis-list">
                    {d.hypotheses.map((h) => (
                      <button key={h.hypothesisId} type="button" className="card" style={{ textAlign: 'left', padding: 12, outline: selected === h.hypothesisId ? '2px solid var(--accent)' : undefined }} onClick={() => setSelected(h.hypothesisId)} data-testid="hypothesis-row">
                        <div className="row gap2" style={{ flexWrap: 'wrap' }}>
                          <Badge tone={h.registered ? 'ok' : 'warn'}>{h.registered ? 'frozen' : 'draft'}</Badge>
                          <Badge outline>v{h.version}</Badge>
                          {!h.registered && <Badge tone="warn" title="No preregistration: results cannot count as confirmatory.">unregistered</Badge>}
                        </div>
                        <div className="small strong" style={{ marginTop: 6 }}>{h.proposition}</div>
                        <div className="tiny dim">{h.claimCount ?? 0} claim(s), {h.experimentCount ?? 0} experiment(s)</div>
                      </button>
                    ))}
                  </div>
                  <div>{selected ? <Detail wid={wid} hid={selected} onFork={setSelected} /> : <Card title="Detail"><div className="small dim">Select a hypothesis.</div></Card>}</div>
                </div>
              )
            }
          </Slot>
        </div>
      </Content>
    </>
  );
}

function Detail({ wid, hid, onFork }: { wid: string; hid: string; onFork: (id: string) => void }) {
  const q = useQuery({ queryKey: rk.hypothesis(wid, hid), queryFn: () => research.hypothesis(wid, hid) });
  return <Slot q={q} rows={5}>{(h) => <DetailBody key={h.versionId} wid={wid} h={h} onFork={onFork} />}</Slot>;
}

function DetailBody({ wid, h, onFork }: { wid: string; h: HypothesisDetail; onFork: (id: string) => void }) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: rk.hypotheses(wid) });
    void qc.invalidateQueries({ queryKey: rk.hypothesis(wid, h.hypothesisId) });
  };
  const frozen = h.status === 'frozen';
  const [d, setD] = useState<Draft>({ proposition: h.proposition, target: h.target, predictor: h.predictor, benchmark: h.benchmark, falsification: h.falsification });
  const [reason, setReason] = useState('');
  const [preHash, setPreHash] = useState('');
  const [linkKind, setLinkKind] = useState<'claim' | 'experiment' | 'finding'>('claim');
  const [linkRef, setLinkRef] = useState('');
  const claims = useQuery({ queryKey: rk.claims(wid), queryFn: () => research.claims(wid) });
  const exps = useQuery({ queryKey: rk.experiments(wid), queryFn: () => research.experiments(wid) });

  const save = useMutation({ mutationFn: () => research.patchHypothesis(wid, h.hypothesisId, d), onSuccess: refresh });
  const freeze = useMutation({ mutationFn: () => research.freezeHypothesis(wid, h.hypothesisId, { expectedVersion: h.version, ...(preHash.trim() ? { preregistrationHash: preHash.trim() } : {}) }), onSuccess: refresh });
  const amend = useMutation({ mutationFn: () => research.amendHypothesis(wid, h.hypothesisId, { ...d, reason: reason.trim() }), onSuccess: () => { setReason(''); refresh(); } });
  const fork = useMutation({ mutationFn: () => research.forkHypothesis(wid, h.hypothesisId, { ...d, ...(reason.trim() ? { reason: reason.trim() } : {}) }), onSuccess: (n) => { refresh(); onFork(n.hypothesisId); } });
  const link = useMutation({ mutationFn: () => research.linkHypothesis(wid, h.hypothesisId, { kind: linkKind, ref: linkRef }), onSuccess: () => { setLinkRef(''); refresh(); } });
  const verify = useMutation({ mutationFn: () => research.verifyHypothesis(wid, h.hypothesisId) });

  const refChoices =
    linkKind === 'claim' ? (claims.data?.claims ?? []).map((c) => ({ value: c.claimId, label: c.statement.slice(0, 70) })) : linkKind === 'experiment' ? (exps.data?.experiments ?? []).map((e) => ({ value: e.experimentId, label: `${e.name} (${e.status})` })) : [];
  const changed = d.proposition !== h.proposition || d.target !== h.target || d.predictor !== h.predictor || d.benchmark !== h.benchmark || d.falsification !== h.falsification;

  return (
    <div className="col gap3" data-testid="hypothesis-detail" data-status={h.status}>
      <Card title={`Version ${h.version}`} actions={<Badge tone={frozen ? 'ok' : 'warn'}>{frozen ? 'frozen' : 'draft'}</Badge>}>
        <HypothesisFields d={d} set={setD} disabled={false} />
        {frozen && <Notice tone="info" title="Frozen">This version cannot be edited. Changing the text and amending creates version {h.version + 1}; forking starts a new hypothesis.</Notice>}
        <div className="col gap2" style={{ marginTop: 12 }}>
          {!frozen && (
            <>
              <div className="row gap2"><Button disabled={!changed} disabledReason="No changes to save." pending={save.isPending} onClick={() => save.mutate()} data-testid="save-draft">Save draft</Button></div>
              <Field label="Preregistration hash (optional)" help="A sha256 of a registered analysis plan. It is verified against research runs the platform holds; otherwise it is labelled user supplied.">
                <Input aria-label="Preregistration hash" placeholder="sha256:…" value={preHash} onChange={(e) => setPreHash(e.target.value)} />
              </Field>
              <div><Button variant="primary" disabled={changed} disabledReason="Save your changes before freezing." pending={freeze.isPending} onClick={() => freeze.mutate()} data-testid="freeze">Freeze hypothesis</Button></div>
            </>
          )}
          {frozen && (
            <Field label="Reason" help="Required to amend. Optional for a fork.">
              <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </Field>
          )}
          {frozen && (
            <div className="row gap2" style={{ flexWrap: 'wrap' }}>
              <Button variant="primary" disabled={!changed || reason.trim().length < 5} disabledReason="Edit the text and give a reason of at least 5 characters." pending={amend.isPending} onClick={() => amend.mutate()} data-testid="amend">Amend (new version)</Button>
              <Button pending={fork.isPending} onClick={() => fork.mutate()} data-testid="fork">Fork as a new hypothesis</Button>
            </div>
          )}
          <MutationError error={save.error ?? freeze.error ?? amend.error ?? fork.error} />
        </div>
      </Card>

      <Card title="Registration">
        {frozen ? (
          <KeyValues
            rows={[
              { k: 'Registration hash', v: <span className="mono small" title={h.registrationHash ?? ''} data-testid="registration-hash">{h.registrationHash ? shortHash(h.registrationHash, 14, 8) : '—'}</span> },
              { k: 'Frozen', v: formatUtc(h.registeredAt) },
              { k: 'Preregistration', v: h.preregistration ? <span className="small"><Badge tone={h.preregistration.verified ? 'ok' : 'warn'}>{h.preregistration.verified ? 'verified' : h.preregistration.source}</Badge> <span className="mono">{shortHash(h.preregistration.hash, 14, 8)}</span><div className="tiny dim">{h.preregistration.note}</div></span> : 'none supplied' },
              { k: 'Chain commitment', v: <span title="A freeze is a content hash with a database timestamp. It does not prove the data was unseen.">none (hash and timestamp only)</span> },
            ]}
          />
        ) : (
          <div className="small dim">Not registered. A draft can change without a trace; freeze it to record the hash.</div>
        )}
        <div style={{ marginTop: 8 }}>
          <Button pending={verify.isPending} onClick={() => verify.mutate()} data-testid="verify">Verify hash chain</Button>
          {verify.data && (
            <div className="small" data-testid="verify-result" data-intact={verify.data.intact} style={{ marginTop: 6 }}>
              <Badge tone={verify.data.intact ? 'ok' : 'bad'}>{verify.data.intact ? 'intact' : 'does not match'}</Badge> {verify.data.checks.length} frozen version(s) recomputed.
            </div>
          )}
          <MutationError error={verify.error} />
        </div>
      </Card>

      <Card title="Versions">
        <ul className="small">
          {h.versions.map((v) => (
            <li key={v.versionId}>v{v.version} <Badge tone={v.status === 'frozen' ? 'ok' : 'warn'}>{v.status}</Badge> {v.registrationHash ? <span className="mono">{shortHash(v.registrationHash, 12, 6)}</span> : null} {v.forkedFromVersionId ? <span className="tiny dim">forked</span> : null}</li>
          ))}
        </ul>
      </Card>

      <Card title="Linked evidence">
        {h.links.length === 0 ? (
          <div className="small dim">Nothing linked. Link claims, research runs or findings that test this hypothesis.</div>
        ) : (
          <ul className="small" data-testid="hypothesis-links">
            {h.links.map((l, i) => (
              <li key={i}>
                <Badge outline>{l.kind}</Badge>{' '}
                {l.kind === 'claim' ? <Link className="link" href={`/w/${wid}/claims/${l.ref}`}>{l.ref}</Link> : l.kind === 'experiment' ? <Link className="link" href={`/w/${wid}/experiments/${l.ref}`}>{l.ref}</Link> : <span className="mono">{l.ref}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="row gap2" style={{ alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}>
          <Field label="Kind"><Select aria-label="Link kind" value={linkKind} onChange={(e) => { setLinkKind(e.target.value as typeof linkKind); setLinkRef(''); }} options={[{ value: 'claim', label: 'Claim' }, { value: 'experiment', label: 'Experiment (research run)' }, { value: 'finding', label: 'Finding id' }]} /></Field>
          <Field label="Reference">
            {linkKind === 'finding' ? <Input aria-label="Finding id" value={linkRef} onChange={(e) => setLinkRef(e.target.value)} placeholder="finding uuid" /> : <Select aria-label="Reference" value={linkRef} onChange={(e) => setLinkRef(e.target.value)} options={[{ value: '', label: 'Select' }, ...refChoices]} />}
          </Field>
          <Button disabled={!linkRef} disabledReason="Choose what to link." pending={link.isPending} onClick={() => link.mutate()} data-testid="add-link">Link</Button>
        </div>
        <MutationError error={link.error} />
      </Card>
    </div>
  );
}
