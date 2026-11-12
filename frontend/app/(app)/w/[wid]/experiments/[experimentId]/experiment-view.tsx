'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Card, KeyValues, Notice } from '@/components/nx/ui';
import { Slot, fmtNum } from '@/components/nx/research-kit';
import { FailedIntegrity, IntegrityBadge, ModelTable, ReasonList, VerdictBadge } from '@/components/nx/experiment-parts';
import { research, rk, type Experiment } from '@/lib/research/api';
import { shortHash } from '@/lib/format';

type Comparison = {
  key: string; candidate: string; horizon: number; nOrigins: number; maeBaseline: number; maeCandidate: number; deltaMae: number; relativeImprovement: number;
  deltaMaeCi?: { lo: number; hi: number; level: number }; pRaw?: number; pAdjusted?: number; fdrReject?: boolean;
  inference?: { status: string; significanceClaimAllowed: boolean; conclusion?: { state?: string }; limitations?: string[] };
};
type Robustness = { hashed?: boolean; note?: string; rows?: { name: string; status: string; delta_mae?: number | null; n_origins?: number; [k: string]: unknown }[]; signFlipRule?: string };

export default function ExperimentView({ wid, eid }: { wid: string; eid: string }) {
  const q = useQuery({ queryKey: rk.experiment(wid, eid), queryFn: () => research.experiment(wid, eid) });
  return (
    <>
      <PageHeader
        title={q.data?.name ?? 'Experiment'}
        crumbs={[{ label: 'Experiments', href: `/w/${wid}/experiments` }, { label: eid.slice(0, 24) }]}
        context={q.data ? <><IntegrityBadge e={q.data} />{q.data.integrity === 'verified' && <VerdictBadge status={q.data.status} />}</> : undefined}
      />
      <Content><Slot q={q} rows={6}>{(e) => <Body wid={wid} e={e as Experiment & Record<string, unknown>} />}</Slot></Content>
    </>
  );
}

function Body({ wid, e }: { wid: string; e: Experiment & Record<string, unknown> }) {
  if (e.integrity !== 'verified') return <FailedIntegrity issues={e.integrityIssues} />;
  const comps = (e.comparisons as Comparison[] | undefined) ?? [];
  const rob = e.robustness as Robustness | undefined;
  const limits = (e.limitations as string[] | undefined) ?? [];
  const counter = (e.counterevidence as { candidate: string; horizon: number; kind: string; delta_mae?: number; p_adjusted?: number }[] | undefined) ?? [];
  return (
    <div className="col gap3" data-testid="experiment-detail" data-status={e.status}>
      {!e.methodValidated && (
        <Notice tone="warn" title="Method not validated">
          The statistical method has not passed validation, so no significance claim is allowed from this run. Figures are descriptive.
        </Notice>
      )}
      {e.status === 'INSUFFICIENT_DATA' && (
        <Notice tone="warn" title="Insufficient data">The run could not reach a verdict on the data available. That is the result, not a failure to display.</Notice>
      )}
      <div className="grid c2">
        <Card title="Run">
          <KeyValues rows={[
            { k: 'Verdict', v: <VerdictBadge status={e.status} /> },
            { k: 'Evidence strength', v: e.evidenceStrength },
            { k: 'Claim scope', v: e.claimScope },
            { k: 'Method', v: <span className="mono small">{e.methodVersion}</span> },
            { k: 'Loss', v: <span className="mono small">{e.loss}</span> },
            { k: 'Horizons (days)', v: e.horizons.join(', ') },
            { k: 'Origins scored', v: <span className="mono">{e.origins}</span> },
            { k: 'Window', v: e.window ? `${e.window.firstOrigin} to ${e.window.lastOrigin}` : '—' },
          ]} />
          <ReasonList codes={e.reasonCodes} />
        </Card>
        <Card title="Pre-registration">
          <KeyValues rows={[
            { k: 'Hash', v: e.preregistrationHash ? <span className="mono small" title={e.preregistrationHash}>{shortHash(e.preregistrationHash, 14, 8)}</span> : 'none' },
            { k: 'Verified', v: <Badge tone={e.preregistrationVerified ? 'ok' : 'warn'}>{e.preregistrationVerified ? 'matches the frozen document' : 'not verified'}</Badge> },
            { k: 'Study', v: <span className="mono small">{e.studyId}</span> },
            { k: 'Linked hypotheses', v: e.hypothesisIds.length ? e.hypothesisIds.map((h) => <Link key={h} className="link" href={`/w/${wid}/hypotheses`}>{h.slice(0, 8)} </Link>) : 'none' },
          ]} />
        </Card>
      </div>

      <Card title="Models" subtitle="Out-of-sample error per model on the scored origins. Lower is better; only the baseline comparison below says whether a gain is meaningful.">
        <ModelTable models={e.models} />
      </Card>

      <Card title="Comparison to baseline" subtitle="Per candidate and horizon, with the inference status the run recorded.">
        <div className="rs-scroll">
          <table className="table" data-testid="comparisons">
            <thead><tr><th>Candidate</th><th>Horizon</th><th className="num">ΔMAE</th><th>95% CI</th><th className="num">Adj. p</th><th>Inference</th></tr></thead>
            <tbody>
              {comps.map((c) => (
                <tr key={c.key}>
                  <td>{c.candidate}</td><td>{c.horizon}d</td>
                  <td className="num mono">{fmtNum(c.deltaMae, 5)}</td>
                  <td className="mono small">{c.deltaMaeCi ? `${fmtNum(c.deltaMaeCi.lo, 5)} to ${fmtNum(c.deltaMaeCi.hi, 5)}` : '—'}</td>
                  <td className="num mono">{fmtNum(c.pAdjusted, 3)}</td>
                  <td><VerdictBadge status={c.inference?.status ?? 'unknown'} />{c.inference?.significanceClaimAllowed === false && <div className="tiny dim">no significance claim allowed</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Robustness checks">
        {rob ? (
          <div className="col gap2">
            {rob.hashed === false && <Notice tone="warn" title="Not hash-committed">{rob.note ?? 'The robustness matrix is not covered by the run hash.'}</Notice>}
            <table className="table">
              <thead><tr><th>Variant</th><th>Status</th><th className="num">ΔMAE</th><th className="num">Origins</th></tr></thead>
              <tbody>{(rob.rows ?? []).map((r) => <tr key={r.name}><td>{r.name}</td><td><VerdictBadge status={String(r.status)} /></td><td className="num mono">{fmtNum(r.delta_mae ?? null, 5)}</td><td className="num mono">{r.n_origins ?? '—'}</td></tr>)}</tbody>
            </table>
            {rob.signFlipRule && <div className="tiny dim">{rob.signFlipRule}</div>}
          </div>
        ) : <div className="small dim">No robustness matrix recorded for this run.</div>}
      </Card>

      <div className="grid c2">
        <Card title="Counter-evidence">
          {counter.length === 0 ? <div className="small dim">None recorded.</div> : <ul className="small">{counter.slice(0, 12).map((c, i) => <li key={i}>{c.candidate} at {c.horizon}d: {c.kind.replace(/_/g, ' ')} (ΔMAE {fmtNum(c.delta_mae ?? null, 5)})</li>)}</ul>}
        </Card>
        <Card title="Limitations">
          {limits.length === 0 ? <div className="small dim">None recorded.</div> : <ul className="small">{limits.map((l, i) => <li key={i}>{l.length > 260 ? `${l.slice(0, 260)}…` : l}</li>)}</ul>}
        </Card>
      </div>
    </div>
  );
}
