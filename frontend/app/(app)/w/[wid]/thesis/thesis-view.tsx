'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice, Select } from '@/components/nx/ui';
import { MutationError, Slot } from '@/components/nx/research-kit';
import { exportThesisHref, research, rk, type ThesisValidation } from '@/lib/research/api';
import { formatUtc, shortHash } from '@/lib/format';

const SEV_TONE = { blocking: 'bad', warning: 'warn', info: 'info' } as const;

export default function ThesisView({ wid }: { wid: string }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: rk.theses(wid), queryFn: () => research.theses(wid) });
  const elig = useQuery({ queryKey: ['ws', wid, 'eligibility'], queryFn: () => research.eligibility(wid) });
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () => research.createThesis(wid, title.trim()),
    onSuccess: (r) => {
      setTitle('');
      setSelected(r.documentId);
      void qc.invalidateQueries({ queryKey: rk.theses(wid) });
    },
  });
  return (
    <>
      <PageHeader title="Thesis" description="A document assembled only from claims with complete provenance. Unsupported claims are listed apart, and verdicts are shown as the research stated them." />
      <Content>
        <div className="col gap3">
          <Card title="Publication eligibility" subtitle="Which claims can be stated as supported right now.">
            <Slot q={elig} rows={2}>
              {(e) => (
                <div className="col gap2" data-testid="eligibility">
                  <KeyValues rows={[
                    { k: 'Supported claims', v: <span className="mono" data-testid="thesis-supported">{e.supportedClaimIds.length}</span> },
                    { k: 'Eligible to publish', v: <span className="mono">{e.publicationEligibleIds.length}</span> },
                    { k: 'Unsupported (excluded)', v: <span className="mono" data-testid="thesis-unsupported">{e.unsupportedSection.claims.length}</span> },
                  ]} />
                  {e.unsupportedSection.claims.length > 0 && (
                    <details>
                      <summary className="small">{e.unsupportedSection.label}</summary>
                      <ul className="small">
                        {e.unsupportedSection.claims.map((c) => (
                          <li key={c.claimId}><Link className="link" href={`/w/${wid}/claims/${c.claimId}`}>{c.label.slice(0, 140)}</Link> <span className="tiny mono">missing: {c.missing.join(', ')}</span></li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </Slot>
          </Card>

          <Card title="Documents" subtitle="Each save is an immutable version with a content digest.">
            <div className="col gap2">
              <div className="row gap2" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
                <Field label="New thesis document">
                  <Input aria-label="Thesis title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={200} />
                </Field>
                <Button variant="primary" disabled={!title.trim()} disabledReason="Give the document a title." pending={create.isPending} onClick={() => create.mutate()} data-testid="create-thesis">Assemble thesis</Button>
              </div>
              <MutationError error={create.error} />
              <Slot q={docs} rows={2}>
                {(d) =>
                  d.documents.length === 0 ? (
                    <EmptyState title="No thesis document yet" body="Assemble one from the workspace’s supported claims, frozen hypotheses and capsules." />
                  ) : (
                    <Select aria-label="Thesis document" value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)} options={[{ value: '', label: 'Select a document' }, ...d.documents.map((x) => ({ value: x.documentId, label: `${x.title} (v${x.latestVersion}, ${x.status})` }))]} />
                  )
                }
              </Slot>
            </div>
          </Card>
          {selected && <Doc wid={wid} did={selected} />}
        </div>
      </Content>
    </>
  );
}

function Checks({ v }: { v: ThesisValidation | undefined }) {
  if (!v) return null;
  return (
    <div className="col gap1" data-testid="thesis-checks" data-status={v.status}>
      <div className="row gap2"><span className="label">Validation</span><Badge tone={v.status === 'ready' || v.status === 'valid' ? 'ok' : v.status === 'blocked' ? 'bad' : 'warn'}>{v.status}</Badge></div>
      <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
        {(v.checks ?? []).map((c) => (
          <li key={c.id} data-check={c.id} data-passed={c.passed}>
            <Badge tone={c.passed ? 'ok' : SEV_TONE[c.severity]}>{c.passed ? 'pass' : c.severity}</Badge> {c.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Doc({ wid, did }: { wid: string; did: string }) {
  const qc = useQueryClient();
  const [version, setVersion] = useState<number | undefined>();
  const q = useQuery({ queryKey: rk.thesis(wid, did, version), queryFn: () => research.thesis(wid, did, version) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: rk.theses(wid) });
    void qc.invalidateQueries({ queryKey: ['ws', wid, 'thesis', did] });
  };
  const validate = useMutation({ mutationFn: () => research.validateThesis(wid, did) });
  const newVer = useMutation({ mutationFn: () => research.newThesisVersion(wid, did), onSuccess: () => { setVersion(undefined); validate.reset(); refresh(); } });
  return (
    <Slot q={q} rows={6}>
      {(d) => {
        const content = d.content as { claims?: { included: { claimId?: string; statement?: string }[]; excluded: { claimId: string; statement: string; missing: string[]; reason: string }[] }; experiments?: { experimentId?: string; name?: string; status?: string; methodValidated?: boolean }[]; limitations?: string[]; unregisteredHypotheses?: number };
        const latest = d.versions[d.versions.length - 1]?.version;
        return (
          <div className="col gap3" data-testid="thesis-doc" data-version={d.version}>
            <Card
              title={d.title}
              subtitle={`Version ${d.version}${latest && d.version !== latest ? ` (latest is ${latest})` : ''}`}
              actions={
                <div className="row gap2" style={{ flexWrap: 'wrap' }}>
                  <Button pending={validate.isPending} onClick={() => validate.mutate()} data-testid="validate-thesis">Check against current evidence</Button>
                  <Button pending={newVer.isPending} onClick={() => newVer.mutate()} data-testid="new-version">Save new version</Button>
                  <a className="btn" href={exportThesisHref(wid, did, 'markdown', d.version)} download data-testid="export-md">Markdown</a>
                  <a className="btn" href={exportThesisHref(wid, did, 'pdf', d.version)} download data-testid="export-pdf">PDF</a>
                </div>
              }
            >
              <KeyValues rows={[
                { k: 'Status', v: <Badge tone={d.status === 'blocked' ? 'bad' : 'ok'}>{d.status}</Badge> },
                { k: 'Content digest', v: <span className="mono small" title={d.digest} data-testid="thesis-digest">{shortHash(d.digest, 16, 8)}</span> },
                { k: 'Versions', v: <span className="row gap1" style={{ flexWrap: 'wrap' }}>{d.versions.map((v) => <Button key={v.version} variant={v.version === d.version ? 'primary' : 'ghost'} onClick={() => setVersion(v.version)}>v{v.version}</Button>)}</span> },
              ]} />
              <MutationError error={validate.error ?? newVer.error} />
              {validate.data && (
                <Notice tone={validate.data.upToDate ? 'ok' : 'warn'} title={validate.data.upToDate ? 'Up to date' : 'The evidence changed since this version'}>
                  {validate.data.upToDate ? 'Assembling again today would give the same content digest.' : 'Assembling now would produce a different digest. Save a new version to capture the change.'}
                </Notice>
              )}
              {newVer.data && <Notice tone={newVer.data.changedSincePrevious ? 'ok' : 'info'} title={`Saved version ${newVer.data.version}`}>{newVer.data.changedSincePrevious ? 'The content changed from the previous version.' : 'The content is identical to the previous version.'}</Notice>}
            </Card>

            {d.status === 'blocked' && <Notice tone="bad" title="Blocked">A blocking check failed. This document is a record of what exists, not a publishable thesis.</Notice>}
            <Card title="Checks"><Checks v={(validate.data?.validation ?? d.validation) as ThesisValidation | undefined} /></Card>

            <Card title={`Included claims (${content.claims?.included.length ?? 0})`}>
              {(content.claims?.included.length ?? 0) === 0 ? <div className="small dim">No claim has complete provenance, so none is stated as supported.</div> : (
                <ul className="small">{content.claims!.included.map((c, i) => <li key={c.claimId ?? i}>{c.claimId ? <Link className="link" href={`/w/${wid}/claims/${c.claimId}`}>{c.statement}</Link> : c.statement}</li>)}</ul>
              )}
            </Card>
            <Card title={`Unsupported, excluded (${content.claims?.excluded.length ?? 0})`} subtitle="Listed apart so they cannot be mistaken for findings.">
              {(content.claims?.excluded.length ?? 0) === 0 ? <div className="small dim">None.</div> : (
                <ul className="small" data-testid="thesis-excluded">{content.claims!.excluded.map((c) => <li key={c.claimId}><Link className="link" href={`/w/${wid}/claims/${c.claimId}`}>{c.statement.slice(0, 160)}</Link> <span className="tiny mono">{c.reason}; missing: {c.missing.join(', ')}</span></li>)}</ul>
              )}
            </Card>
            <Card title="Experiments">
              {(content.experiments?.length ?? 0) === 0 ? <div className="small dim">No research run is linked to the included hypotheses.</div> : (
                <ul className="small">{content.experiments!.map((x, i) => <li key={x.experimentId ?? i}>{x.name ?? x.experimentId} {x.status && <Badge tone="warn">{x.status.replace(/_/g, ' ').toLowerCase()}</Badge>} {x.methodValidated === false && <Badge tone="warn">method not validated</Badge>}</li>)}</ul>
              )}
            </Card>
            {(content.limitations?.length ?? 0) > 0 && <Card title="Limitations"><ul className="small">{content.limitations!.map((l, i) => <li key={i}>{l}</li>)}</ul></Card>}
            <Card title="Document text"><pre className="rs-pre rs-scroll" data-testid="thesis-markdown">{d.markdown}</pre></Card>
          </div>
        );
      }}
    </Slot>
  );
}
