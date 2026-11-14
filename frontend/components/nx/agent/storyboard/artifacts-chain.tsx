'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader, X } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { LocalBadge, OutlayerBadge } from '@/components/ws6/capsule-bits';
import { Skeleton } from '@/components/nx/ui';
import { browserApi } from '@/lib/api/browser';
import { formatUtc, shortHash } from '@/lib/format';
import { formatUsdExact, sumUsd } from '@/lib/credits/usd';
import { proofsApi, type Proof } from '@/lib/near/api';
import { addYocto, formatNear, isYocto, txUrl } from '@/lib/near/units';
import { caps } from '@/lib/ws6/api';
import type { ReportDoc } from '@/lib/report/types';
import { reportPageHref, reportPdfHref } from '@/lib/agent/tasks';
import { ApiRequestError } from '@/lib/api/errors';
import { plainLabel, readableCorrelation, readableNumber, stripStatusPrefix } from '@/lib/thesis/display';
import { THESIS_TONE, THESIS_VERDICT_LABEL, compareOutcome, compareRows, proofPipeline, thesisPathOf, thesisView, type PipeStep, type Stage } from '@/lib/agent/storyboard';
import { CopyChip, SbCard } from './parts';
import { useOnChange } from './data';
import StrengthMeter from '@/components/nx/thesis/strength-meter';
import { normalizeStrength } from '@/lib/thesis/strength';
import { normalizeDoc } from '@/lib/thesis/doc';
import { CHOSEN_BY_LABEL } from '@/lib/agent/testplan';

const NoId = ({ what }: { what: string }) => <SbCard><p className="sb-note">{what}: unknown. The agent did not report an id for it.</p></SbCard>;

/* ------------------------------------------------------------------------------------------------ 7. capsule */

export function useCapsuleView(capsuleId: string | null) {
  return useQuery({ queryKey: ['capsule', capsuleId ?? ''], queryFn: () => caps.view(capsuleId!), enabled: !!capsuleId, staleTime: 20_000, retry: false });
}

export function CapsuleArtifact({ wid, stage }: { wid: string | null; stage: Stage }) {
  const id = stage.refs.capsuleId ?? null;
  const q = useCapsuleView(id);
  useOnChange(stage.state, () => void q.refetch());
  if (!id) return <NoId what="Capsule" />;
  if (q.isPending) return <SbCard><Skeleton rows={4} /></SbCard>;
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.status === 'unavailable') return <SbCard><p className="sb-note">The capsule is unavailable: {q.data.reason}</p></SbCard>;
  const c = q.data.capsule;
  const hash = stage.steps.flatMap((s) => s.result?.items ?? []).find((i) => i.label.toLowerCase() === 'hash')?.value ?? null;
  const manifest = c.hashes.resultManifestHash ?? null;
  const metrics = c.results.slice(0, 6);
  const coverage = c.claims.find((x) => x.claimClass === 'observed_fact');
  return (
    <SbCard
      testId="sb-capsule"
      label="Capsule"
      title={c.title}
      badges={
        <>
          <Badge tone="accent">{c.sourceLabel || 'unknown'}</Badge>
          <LocalBadge v={c.verification.local} />
        </>
      }
      tools={wid ? <Link className="sb-link" href={`/w/${wid}/capsules/${id}`}>Open capsule</Link> : null}
      foot={
        <>
          <span className="mono">built {formatUtc(c.createdAt)}</span>
          <span className="mono" title={id}>{id}</span>
        </>
      }
    >
      <dl className="sb-ident">
        <div>
          <dt>Capsule hash</dt>
          <dd>{hash ? <CopyChip value={hash} short={shortHash(hash, 12, 8)} label="capsule hash" /> : manifest ? <span className="sb-dim">not reported</span> : <span className="sb-dim">unknown</span>}</dd>
        </div>
        <div>
          <dt>Result manifest</dt>
          <dd>{manifest ? <CopyChip value={manifest} short={shortHash(manifest, 12, 8)} label="result manifest hash" /> : <span className="sb-dim">unknown</span>}</dd>
        </div>
      </dl>
      {coverage && <p className="sb-reason">{coverage.text}</p>}
      {metrics.length > 0 && (
        <ul className="sb-metrics" aria-label="What the capsule recomputes">
          {metrics.map((m) => (
            <li key={m.id} title={m.computation}>
              <span className="sb-metric-v">{m.value}<span className="sb-metric-u">{m.unit}</span></span>
              <span className="sb-metric-l">{m.label}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="sb-note">{c.verification.local.detail}</p>
    </SbCard>
  );
}

/* ------------------------------------------------------------------------------------------------ 8. proof */

export function useProof(proofId: string | null, capsuleId: string | null, active: boolean) {
  const byId = useQuery({
    queryKey: ['proof', proofId ?? ''],
    queryFn: () => proofsApi.get(proofId!),
    enabled: !!proofId,
    retry: false,
    staleTime: 10_000,
    refetchInterval: (q) => (active || (q.state.data && q.state.data.state === 'running') ? 3000 : false),
  });
  // Only when the task has no proof id (it is still being created) does the capsule's own list say which proof is running.
  const list = useQuery({
    queryKey: ['capsule', capsuleId ?? '', 'proofs'],
    queryFn: () => proofsApi.list(capsuleId!),
    enabled: !proofId && !!capsuleId && active,
    retry: false,
    refetchInterval: active ? 3000 : false,
  });
  return { proof: byId.data ?? (!proofId ? list.data?.items?.[0] ?? null : null), pending: byId.isPending && !!proofId, error: byId.isError ? byId.error : null, refetch: byId.refetch };
}

function PipeIcon({ state }: { state: PipeStep['state'] }) {
  const p = { size: 14, 'aria-hidden': true } as const;
  return state === 'done' ? <Check {...p} /> : state === 'failed' ? <X {...p} /> : state === 'active' ? <Loader {...p} className="ag-spin" /> : <span className="sb-pipe-dot" aria-hidden="true" />;
}

export function ProofPipeline({ steps }: { steps: PipeStep[] }) {
  return (
    <ol className="sb-pipe" aria-label="Proof progress" data-testid="sb-pipeline">
      {steps.map((s, i) => (
        <li key={s.key} data-s={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
          <span className="sb-pipe-node"><PipeIcon state={s.state} /></span>
          <span className="sb-pipe-label">{s.label}</span>
          <span className="sb-pipe-state">{s.state === 'done' ? 'done' : s.state === 'active' ? 'working' : s.state === 'failed' ? 'stopped' : 'waiting'}</span>
          {i < steps.length - 1 && <span className="sb-pipe-link" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export function ProofArtifact({ stage }: { stage: Stage }) {
  const { proof, pending, error, refetch } = useProof(stage.refs.proofId ?? null, stage.refs.capsuleId ?? null, stage.state === 'working');
  useOnChange(stage.state, () => void refetch());
  const working = stage.state === 'working';
  if (!stage.refs.proofId && !proof && !working) return <NoId what="Proof" />;
  if (pending) return <SbCard><Skeleton rows={3} /></SbCard>;
  if (error && !proof) return <ApiErrorState error={error} onRetry={() => refetch()} />;
  // Submitted is the first thing that happens, so a working proof stage with nothing back yet shows it as in progress.
  const steps: PipeStep[] = proof ? proofPipeline(proof) : proofPipeline(null).map((s, i) => (i === 0 ? { ...s, state: 'active' as const } : s));
  return (
    <SbCard
      testId="sb-proof"
      label="OutLayer proof"
      title="Capsule re-run in secure hardware"
      badges={proof ? <ProofBadge p={proof} /> : <Badge tone="info">starting</Badge>}
      tools={proof?.job.explorerUrl || proof?.job.txHash ? <a className="sb-link" href={proof.job.explorerUrl ?? txUrl(proof.job.txHash!)} target="_blank" rel="noreferrer noopener">View transaction</a> : null}
      foot={
        <>
          <span className="mono">{proof ? `started ${formatUtc(proof.createdAt)}` : 'not started'}</span>
          {proof?.finishedAt && <span className="mono">finished {formatUtc(proof.finishedAt)}</span>}
          <span className="mono">{proof?.job.network ?? 'testnet'}</span>
        </>
      }
    >
      <ProofPipeline steps={steps} />
      {proof?.error && <p className="sb-fail" role="alert"><span className="mono">{proof.error}</span></p>}
      {proof && proof.verification.reasons.length > 0 && <ul className="sb-reasons">{proof.verification.reasons.map((r, i) => <li key={i} className="mono">{r}</li>)}</ul>}
      {proof && <ProofFacts p={proof} />}
    </SbCard>
  );
}

function ProofBadge({ p }: { p: Proof }) {
  const tone = p.state === 'verified' ? 'ok' : p.state === 'running' ? 'info' : p.state === 'not_attested' ? 'warn' : 'bad';
  return (
    <>
      <Badge tone={tone}>{p.state.replace(/_/g, ' ')}</Badge>
      {p.verification.decision && <Badge outline>{p.verification.decision}</Badge>}
    </>
  );
}

function ProofFacts({ p }: { p: Proof }) {
  const totalUsd = p.cost.totalUsd ?? sumUsd(p.cost.chargedUsd, p.cost.gasUsd);
  const totalYocto = p.cost.totalYocto ?? addYocto(p.cost.chargedYocto, p.cost.gasYocto);
  const rate = p.cost.nearUsdRate === null || p.cost.nearUsdRate === undefined ? null : String(p.cost.nearUsdRate);
  const near = isYocto(totalYocto) ? `${formatNear(totalYocto, { round: 'up' })} NEAR${rate ? ` at $${rate} per NEAR${p.cost.rateDate ? ` on ${p.cost.rateDate}` : ''}` : ''}` : null;
  const tx = p.job.txHash;
  return (
    <>
      <dl className="sb-facts">
        <div>
          <dt>Request id</dt>
          <dd className="mono">{p.job.requestId ?? <span className="sb-dim">none yet</span>}</dd>
        </div>
        <div>
          <dt>Transaction</dt>
          <dd>{tx ? <a className="sb-link mono" href={p.job.explorerUrl ?? txUrl(tx)} target="_blank" rel="noreferrer noopener" data-testid="sb-proof-tx" title={tx}>{shortHash(tx, 10, 6)}</a> : <span className="sb-dim">none yet</span>}</dd>
        </div>
        <div>
          <dt>Hardware measurement (mrTd)</dt>
          <dd>{p.verification.mrTd ? <CopyChip value={p.verification.mrTd} short={shortHash(p.verification.mrTd, 12, 8)} label="mrTd" /> : <span className="sb-dim">not fetched yet</span>}</dd>
        </div>
        <div>
          <dt>Runtime measurement (rtmr3)</dt>
          <dd>{p.verification.rtmr3 ? <CopyChip value={p.verification.rtmr3} short={shortHash(p.verification.rtmr3, 12, 8)} label="rtmr3" /> : <span className="sb-dim">not fetched yet</span>}</dd>
        </div>
        <div className="sb-facts-cost">
          <dt>Cost to you</dt>
          <dd>
            <span className="sb-cost-v">{formatUsdExact(totalUsd, { decimals: 4, round: 'up' })}</span>
            {near && <span className="sb-dim mono"> {near}</span>}
          </dd>
        </div>
      </dl>
      {!p.verification.collateralChecked && <p className="sb-note" data-testid="sb-collateral">Intel collateral (TCB status) not checked.</p>}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------ 9. publication */

export function PublicationArtifact({ stage }: { stage: Stage }) {
  const id = stage.refs.capsuleId ?? null;
  const pub = useQuery({ queryKey: ['capsule', id ?? '', 'publication'], queryFn: () => caps.publication(id!), enabled: !!id, staleTime: 15_000, retry: false });
  const view = useCapsuleView(id);
  useOnChange(stage.state, () => void pub.refetch());
  if (!id) return <NoId what="Capsule" />;
  if (pub.isPending) return <SbCard><Skeleton rows={2} /></SbCard>;
  if (pub.isError) return <ApiErrorState error={pub.error} onRetry={() => pub.refetch()} />;
  const rec = pub.data.record;
  const open = pub.data.public;
  const outlayer = view.data?.status === 'available' ? view.data.capsule.verification.outlayer : null;
  return (
    <SbCard
      testId="sb-publication"
      label="Publication"
      title={open ? 'Public page is live' : 'Not public'}
      badges={
        <>
          <Badge tone={open ? 'ok' : 'warn'}>{open ? 'published' : rec?.state === 'unpublished' ? 'withdrawn' : 'not published'}</Badge>
          {rec?.badge && <Badge outline title="Verification badge shown on the public page">badge: {rec.badge}</Badge>}
          {outlayer && <OutlayerBadge v={outlayer} />}
        </>
      }
      foot={<span className="mono">{rec ? `published ${formatUtc(rec.at)}` : 'published time unknown'}</span>}
    >
      {open ? (
        <Link className="sb-publink" href={`/public/${encodeURIComponent(id)}`} data-testid="sb-public-link">
          <span className="sb-publink-k">Public page</span>
          <span className="mono">/public/{id}</span>
        </Link>
      ) : (
        <p className="sb-note">Nobody outside your organisation can see this capsule.</p>
      )}
      {rec && rec.acknowledged.length > 0 && <p className="sb-note">Acknowledged before publishing: {rec.acknowledged.join(', ')}.</p>}
    </SbCard>
  );
}

/* ------------------------------------------------------------------------------------------------ 10. workspace summary (older format) */

export function ReportArtifact({ wid, stage }: { wid: string | null; stage: Stage }) {
  const q = useQuery({
    queryKey: ['ws', wid ?? '', 'report'],
    queryFn: () => browserApi.get<ReportDoc>(`/v1/workspaces/${encodeURIComponent(wid!)}/report`),
    enabled: !!wid,
    staleTime: 60_000,
    retry: false,
  });
  useOnChange(stage.state, () => void q.refetch());
  if (!wid) return <NoId what="Workspace" />;
  const d = q.data;
  const findings = d ? d.runs.reduce((n, r) => n + r.interpretation.findings.length, 0) : null;
  return (
    <SbCard
      testId="sb-report"
      label="Older format"
      title="Workspace summary"
      badges={<Badge tone={q.isError ? 'bad' : 'ok'}>{q.isError ? 'unavailable' : 'ready'}</Badge>}
      foot={<span className="mono">{d ? `generated ${formatUtc(d.generatedAt)}` : 'generation time unknown'}</span>}
    >
      {q.isPending ? (
        <Skeleton rows={2} />
      ) : q.isError ? (
        <ApiErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <p className="sb-lead">{d!.workspace.objective}</p>
          <ul className="sb-counts" aria-label="What the summary contains">
            <li><b>{d!.runs.length}</b><span>{d!.runs.length === 1 ? 'question' : 'questions'}</span></li>
            <li><b>{findings}</b><span>{findings === 1 ? 'finding' : 'findings'}</span></li>
            <li><b>{d!.panels.length}</b><span>{d!.panels.length === 1 ? 'chart' : 'charts'}</span></li>
            <li><b>{d!.markers.length}</b><span>{d!.markers.length === 1 ? 'marker' : 'markers'}</span></li>
            <li><b>{d!.monitors.length}</b><span>{d!.monitors.length === 1 ? 'monitor' : 'monitors'}</span></li>
          </ul>
        </>
      )}
      <div className="sb-actions">
        <Link className="sb-btn sb-btn-primary" href={reportPageHref(wid)} data-testid="sb-report-open">Open workspace summary</Link>
        <a className="sb-btn" href={reportPdfHref(wid)} data-testid="sb-report-pdf">Download summary PDF</a>
      </div>
    </SbCard>
  );
}

/* ------------------------------------------------------------------------------------------------ others */

/** A step the storyboard has no artifact for: what the step reported, in its own words. */
export function GenericArtifact({ stage }: { stage: Stage }) {
  const r = stage.steps[0]?.result;
  if (!r) return <SbCard><p className="sb-note">{stage.steps[0]?.detail || 'This step has no result to show yet.'}</p></SbCard>;
  return (
    <SbCard title={stage.steps[0]!.title}>
      {r.summary && <p className="sb-lead">{r.summary}</p>}
      {r.items.length > 0 && (
        <ul className="sb-skipped">
          {r.items.map((i, k) => (
            <li key={k}><Badge outline>{i.label}</Badge><span className="mono">{i.value}</span></li>
          ))}
        </ul>
      )}
    </SbCard>
  );
}

/* ------------------------------------------------------------------------------------------------ thesis */

const num = (n: number | null, digits = 3) => (n === null ? 'unknown' : n.toLocaleString('en-US', { maximumFractionDigits: digits }));
const corr = (n: number | null) => (n === null ? 'unknown' : readableCorrelation(n));

export function ThesisArtifact({ stage }: { stage: Stage }) {
  const id = stage.refs.thesisId ?? null;
  const q = useQuery({ queryKey: ['thesis', id ?? ''], queryFn: () => browserApi.get<{ thesis?: unknown; doc: unknown; receipts?: unknown }>(`/v1/theses/${encodeURIComponent(id!)}`), enabled: !!id, staleTime: 30_000, retry: false });
  useOnChange(stage.state, () => void q.refetch());
  if (!id) return <NoId what="Thesis" />;
  if (q.isPending) return <SbCard><Skeleton rows={4} /></SbCard>;
  if (q.isError) {
    const missing = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <SbCard testId="sb-thesis-unavailable" label="Thesis" title="The thesis is not available" badges={<Badge tone="warn">unavailable</Badge>}>
        <p className="sb-note">{missing ? 'This server does not have the thesis route yet, or the thesis is not yours to read. The agent made it; open it from the link below once the server serves it.' : 'The thesis could not be loaded.'}</p>
        <div className="sb-actions">
          <Link className="sb-btn" href={`/thesis/${encodeURIComponent(id)}`}>Open thesis</Link>
          <button type="button" className="sb-btn" onClick={() => q.refetch()}>Try again</button>
        </div>
      </SbCard>
    );
  }
  const t = thesisView(q.data.doc);
  const strength = normalizeStrength((q.data.thesis as { strength?: unknown } | undefined)?.strength);
  const plan = normalizeDoc(q.data.doc)?.test?.plan ?? null;
  const tone = t.verdict ? (THESIS_TONE[t.verdict] ?? '') : '';
  const tests: [string, string][] = [
    ['Days compared', t.n === null ? 'unknown' : String(t.n)],
    ['Window', t.window ?? 'unknown'],
    [plainLabel('Same-day Pearson correlation').label, corr(t.pearson)],
    [plainLabel('Pearson correlation at a lag of 7 days').label, corr(t.lag7)],
  ];
  return (
    <SbCard
      testId="sb-thesis"
      label="Thesis"
      title="Thesis"
      badges={t.verdict ? <Badge tone={tone}>{THESIS_VERDICT_LABEL[t.verdict] ?? t.verdict.replace(/_/g, ' ').toLowerCase()}</Badge> : <Badge outline>verdict unknown</Badge>}
      foot={
        <>
          <span className="mono">{num(t.charts, 0)} charts</span>
          <span className="mono">{num(t.claims, 0)} claims</span>
          <span className="mono" title={id}>thesis {shortHash(id, 8, 0)}</span>
        </>
      }
    >
      <p className="sb-reason">{plan?.statement ?? t.hypothesis ?? 'The hypothesis is unknown.'}</p>
      {plan && (
        <p className="sb-note" data-testid="sb-thesis-plan">
          Locked {plan.lockedAt ? formatUtc(plan.lockedAt) : 'at an unknown time'}, before the run. Pair chosen by {plan.chosenBy ? CHOSEN_BY_LABEL[plan.chosenBy] : 'unknown'}.
        </p>
      )}
      {strength && <StrengthMeter strength={strength} testId="strength-tile" />}
      <p className="sb-statement" data-testid="sb-thesis-headline">{stripStatusPrefix(t.headline, t.verdict) ?? 'The headline is unknown.'}</p>
      {t.n !== null || t.pearson !== null ? (
        <ul className="sb-metrics" aria-label="The test behind the verdict">
          {tests.map(([l, v]) => (
            <li key={l}><span className="sb-metric-v">{v}</span><span className="sb-metric-l">{l}</span></li>
          ))}
        </ul>
      ) : null}
      <div className="sb-actions">
        <Link className="sb-btn sb-btn-primary" href={`/thesis/${encodeURIComponent(id)}`} data-testid="sb-thesis-open">Open thesis</Link>
        <a className="sb-btn" href={`/api/thesis/${encodeURIComponent(id)}/pdf`} data-testid="sb-thesis-pdf">Download PDF</a>
      </div>
    </SbCard>
  );
}

export function ThesisLinkArtifact({ stage }: { stage: Stage }) {
  const path = thesisPathOf(stage.steps.flatMap((s) => s.result?.items ?? []), '/t/');
  if (!path) return <NoId what="Public thesis page" />;
  const full = typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
  return (
    <SbCard testId="sb-thesis-public" label="Public thesis" title="Public link" badges={<Badge tone="ok">published</Badge>} foot={<span className="mono">anyone with the link can read it</span>}>
      <Link className="sb-publink" href={path}>
        <span className="sb-publink-k">Public thesis page</span>
        <span className="mono">{path}</span>
      </Link>
      <CopyChip value={full} label="public link" />
    </SbCard>
  );
}

export function CompareArtifact({ stage }: { stage: Stage }) {
  const step = stage.steps[stage.steps.length - 1];
  const rows = compareRows(step?.result?.items ?? []);
  const outcome = compareOutcome(step?.result?.summary);
  const tone = outcome === 'match' ? 'ok' : outcome === 'drift' ? 'warn' : outcome === 'different' ? 'bad' : '';
  if (!step?.result) return <GenericArtifact stage={stage} />;
  return (
    <SbCard testId="sb-compare" label="Comparison" title="Original against reproduction" badges={<Badge tone={tone} outline={outcome === 'unknown'}>{outcome === 'unknown' ? 'outcome unknown' : outcome}</Badge>} foot={<span className="mono">{rows.length} row{rows.length === 1 ? '' : 's'} compared</span>}>
      {step.result.summary && <p className="sb-reason">{step.result.summary}</p>}
      {rows.length > 0 && (
        <div className="sb-table-scroll">
          <table className="sb-table">
            <thead><tr><th scope="col">What</th><th scope="col">Original</th><th scope="col">Reproduced</th><th scope="col">Difference</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{plainLabel(r.what).label}</th>
                  <td className="mono" title={r.original ?? undefined}>{r.original === null ? 'unknown' : readableNumber(r.original)}</td>
                  <td className="mono" title={r.reproduced ?? undefined}>{r.reproduced === null ? 'unknown' : readableNumber(r.reproduced)}</td>
                  <td className="mono" title={r.delta ?? undefined}>{r.delta === null ? 'unknown' : readableNumber(r.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SbCard>
  );
}
