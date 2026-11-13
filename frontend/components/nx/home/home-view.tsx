'use client';

import './home.css';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Radio, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import { Band } from '@/components/nx/band';
import { Badge } from '@/components/nx/evidence';
import { SectionBar } from '@/components/nx/section';
import { Button, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { SeriesChart } from '@/components/nx/data/charts';
import { useApiGet, isCannot, type Envelope } from '@/components/nx/data/kit';
import type { LastHour } from '@/components/nx/data/realtime-view';
import { browserApi } from '@/lib/api/browser';
import { fInt, fPct, fUsd, fSeconds } from '@/lib/data/num';
import { formatAge } from '@/lib/format';
import { tidyNumbers } from '@/lib/prose';

/** Questions the live pipeline answers end to end today (Intents Explorer, BigQuery daily chain data, accounts). */
const EXAMPLES = [
  'How has NEAR Intents swap volume changed over the last 90 days?',
  'Which chain pairs carry the most NEAR Intents volume, and how concentrated is it?',
  'How many new versus returning accounts were active on NEAR in the last 30 days?',
  'Which routes have the highest Intents refund rates?',
  'Compare daily NEAR transactions with NEAR Intents swaps since August.',
];

/* ---------------------------------------------------------------- ask box */

function AskBox() {
  const router = useRouter();
  const [q, setQ] = useState('');
  // The question is answered in the Agent tab (a quick answer, no workspace is created here).
  const submit = (text: string) => {
    const t = text.trim().slice(0, 2000);
    if (t) router.push(`/home?tab=agent&q=${encodeURIComponent(t)}`);
  };
  return (
    <form
      className="home-ask"
      onSubmit={(e) => {
        e.preventDefault();
        submit(q);
      }}
    >
      <label htmlFor="home-q" className="sr-only">
        Ask a question about NEAR
      </label>
      <div className="home-ask-row">
        <textarea
          id="home-q"
          data-testid="home-question"
          rows={2}
          maxLength={2000}
          placeholder="Ask anything about NEAR: swaps, accounts, chains, fees…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(q);
            }
          }}
        />
        <Button type="submit" variant="primary" disabled={!q.trim()} disabledReason="Type a question first." data-testid="home-ask-submit">
          Ask <ArrowRight size={14} />
        </Button>
      </div>
      <div className="home-chips" aria-label="Example questions">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" className="home-chip" onClick={() => submit(e)} data-testid="home-example">
            {e}
          </button>
        ))}
      </div>
      <p className="tiny dim">
        This opens the Agent tab and answers your question with charts. Nothing is created until you choose &quot;Create workspace&quot; there and confirm.
      </p>
    </form>
  );
}

/* ------------------------------------------------------------ live strip */

type Fresh = {
  status: string;
  collectorState: string;
  watermark: { height: number; blockTime: string } | null;
  collectorLagSeconds: number | null;
  provider: string;
};

function LiveStrip() {
  const fresh = useQuery({
    queryKey: ['home', 'fresh'],
    queryFn: ({ signal }) => browserApi.get<Fresh>('/v1/realtime/freshness', { signal }),
    refetchInterval: 10_000,
    retry: false,
  });
  const hour = useQuery({
    queryKey: ['home', 'lasthour'],
    queryFn: ({ signal }) => browserApi.get<LastHour>('/v1/realtime/transactions-last-hour', { signal }),
    refetchInterval: 30_000,
    retry: false,
  });
  const f = fresh.data;
  const h = hour.data;
  const live = f?.collectorState === 'live';
  const perMin = h && h.finalized.minutesCovered > 0 ? h.finalized.transactions / h.finalized.minutesCovered : null;
  return (
    <Link href="/data/realtime" className="home-live" data-testid="home-live">
      <span className={`home-dot ${live ? 'on' : f ? 'warn' : ''}`} aria-hidden />
      <span className="home-live-k">NEAR mainnet</span>
      {fresh.isError ? (
        <span className="small dim">Live feed unavailable</span>
      ) : !f ? (
        <span className="small dim">Connecting…</span>
      ) : (
        <>
          <span className="mono">block #{f.watermark ? fInt(f.watermark.height) : '—'}</span>
          <span className="small dim">{f.watermark ? formatAge(f.watermark.blockTime) : ''}</span>
          <span className="home-sep" />
          <span className="mono">{perMin === null ? '—' : fInt(Math.round(perMin))}</span>
          <span className="small dim">tx / min{h && h.status !== 'OK' ? ` (over ${h.finalized.minutesCovered} final min)` : ' (last hour)'}</span>
          <span className="home-sep" />
          <Badge tone={live ? 'ok' : 'warn'}>{live ? 'live' : f.collectorState.replace('_', ' ')}</Badge>
          {!live && f.collectorLagSeconds !== null && <span className="small dim">{fSeconds(f.collectorLagSeconds)} behind</span>}
        </>
      )}
      <span className="grow" />
      <span className="small link">Real-time feed →</span>
    </Link>
  );
}

/* ------------------------------------------------------------ the numbers */

type Summary = { swaps: number; settledVolumeUsdKnown: string | null; successRate: string; refundRate: string; inFlight: number };
type TrendRow = { period: string; swaps: number; volumeUsdKnown: string | null };
type AccountsDaily = {
  from: string;
  to: string;
  coverage: { requestedDays: number; daysWithData: number; missingDays: string[] };
  daily: { date: string; activeAccounts: number; newAccounts: number; returningAccounts: number; organicTransactions: number }[];
};

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function Numbers() {
  const sum = useApiGet<Envelope<Summary>>('/v1/intents/summary', { days: 30 });
  const trend = useApiGet<Envelope<TrendRow[]>>('/v1/intents/trend', { days: 90, granularity: 'day' });
  const acc = useApiGet<AccountsDaily>('/v1/accounts/daily', { days: 90 });

  const s = sum.data && !isCannot(sum.data) ? sum.data : null;
  const t = trend.data && !isCannot(trend.data) ? trend.data : null;
  const a = acc.data ?? null;
  const last30 = a ? a.daily.slice(-30) : [];
  const avgActive = mean(last30.map((d) => d.activeAccounts));
  const avgNew = mean(last30.map((d) => d.newAccounts));
  const avgTx = mean(last30.map((d) => d.organicTransactions));

  return (
    <div className="col gap3">
      {sum.isLoading ? (
        <Skeleton rows={3} />
      ) : sum.isError ? (
        <ApiErrorState error={sum.error} />
      ) : !s ? (
        <p className="small dim">The Intents summary cannot be computed right now.</p>
      ) : (
        <Band
          eyebrow="NEAR Intents · last 30 days"
          lead="Cross-chain swaps settled through NEAR Intents, from the provider Explorer."
          stats={[
            { value: fInt(s.data.swaps), detail: 'swaps', lead: true },
            { value: fUsd(s.data.settledVolumeUsdKnown), detail: 'settled volume (known USD only)' },
            { value: fPct(s.data.successRate), detail: 'of finished swaps succeeded' },
            { value: fPct(s.data.refundRate), detail: 'were refunded' },
          ]}
          footer={
            <span className="row gap2 wrap">
              <span className="tiny">
                {s.coverage?.completeDays ?? '—'}/{s.coverage?.daysInWindow ?? '—'} days complete · {s.provenance.metricVersion ?? 'intents'} ·{' '}
                <Link href="/data/intents" className="link">
                  Open Intents analytics →
                </Link>
              </span>
            </span>
          }
        />
      )}

      <div className="home-kpis" data-testid="home-kpis">
        <Kpi label="Active accounts / day" value={avgActive === null ? '—' : fInt(Math.round(avgActive))} note="30-day average, organic" href="/data/accounts" />
        <Kpi label="New accounts / day" value={avgNew === null ? '—' : fInt(Math.round(avgNew))} note="30-day average" href="/data/accounts" />
        <Kpi label="Transactions / day" value={avgTx === null ? '—' : fInt(Math.round(avgTx))} note="30-day average, organic" href="/data/accounts" />
        <Kpi
          label="Swaps in flight"
          value={s ? fInt(s.data.inFlight) : '—'}
          note="Intents swaps not yet settled"
          href="/data/intents"
        />
      </div>
      {a && a.coverage.missingDays.length > 0 && (
        <p className="tiny dim">Account data is missing {a.coverage.missingDays.length} day(s) in the window; averages use the days that exist.</p>
      )}

      <div className="grid c2">
        <div className="card">
          <header className="card-head">
            <div className="grow">
              <div className="h3">Intents volume, 90 days</div>
              <div className="small dim">Settled USD per day, known USD only. Gaps are missing data, not zero.</div>
            </div>
          </header>
          <div className="card-body">
            {trend.isLoading ? (
              <Skeleton rows={4} />
            ) : trend.isError ? (
              <ApiErrorState error={trend.error} />
            ) : t ? (
              <SeriesChart
                ariaLabel="NEAR Intents daily settled volume, 90 days"
                unit="USD"
                height={240}
                series={[{ name: 'volume (known USD)', points: t.data.map((r) => ({ x: r.period, y: r.volumeUsdKnown })) }]}
              />
            ) : (
              <p className="small dim">Not computable right now.</p>
            )}
          </div>
        </div>
        <div className="card">
          <header className="card-head">
            <div className="grow">
              <div className="h3">Accounts, 90 days</div>
              <div className="small dim">Active and new signing accounts per day, organic traffic (BigQuery daily chain data).</div>
            </div>
          </header>
          <div className="card-body">
            {acc.isLoading ? (
              <Skeleton rows={4} />
            ) : acc.isError ? (
              <ApiErrorState error={acc.error} />
            ) : a ? (
              <SeriesChart
                ariaLabel="NEAR active and new accounts per day, 90 days"
                unit="accounts"
                height={240}
                series={[
                  { name: 'active', points: a.daily.map((d) => ({ x: d.date, y: d.activeAccounts })) },
                  { name: 'new', points: a.daily.map((d) => ({ x: d.date, y: d.newAccounts })) },
                ]}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, note, href }: { label: string; value: string; note: string; href: string }) {
  return (
    <Link href={href} className="home-kpi">
      <span className="label">{label}</span>
      <span className="home-kpi-v mono">{value}</span>
      <span className="tiny dim">{note}</span>
    </Link>
  );
}

/* ------------------------------------------------------- agent findings */

type Finding = {
  runId: string;
  workspaceId: string;
  workspaceObjective: string;
  question: string;
  createdAt: string;
  finding: {
    statement: string;
    basis: 'observation' | 'inference';
    status: 'supported' | 'mixed' | 'insufficient_data' | 'cannot_compute';
    kind?: string;
    facts?: { value: string; unit?: string }[];
    limitations?: string[];
    skepticNotes?: string[];
    skepticDegraded?: boolean;
  };
};

const STATUS_TONE = { supported: 'ok', mixed: 'warn', insufficient_data: '', cannot_compute: 'bad' } as const;

function Findings() {
  const q = useQuery({
    queryKey: ['home', 'findings'],
    queryFn: ({ signal }) => browserApi.get<{ findings: Finding[] }>('/v1/findings', { query: { limit: 12 }, signal }),
    retry: false,
    staleTime: 60_000,
  });
  if (q.isLoading) return <Skeleton rows={4} />;
  if (q.isError) return <ApiErrorState error={q.error} />;
  // Prefer findings that hold up: supported or mixed, newest first; at most one run's worth of duplicates.
  const rows = (q.data?.findings ?? []).filter((f) => f.finding.status === 'supported' || f.finding.status === 'mixed').slice(0, 4);
  if (rows.length === 0)
    return (
      <p className="small dim" data-testid="home-findings-empty">
        No findings yet. Ask a question above: each answer comes back as findings tied to the exact result cells, then challenged by a skeptic agent.
      </p>
    );
  return (
    <div className="home-findings" data-testid="home-findings">
      {rows.map((f, i) => {
        const verdict = (f.finding.limitations ?? []).some((l) => l.includes('materially limits'))
          ? 'weakened'
          : f.finding.skepticDegraded
            ? 'skeptic unavailable'
            : 'holds';
        return (
          <article key={`${f.runId}-${i}`} className="home-finding">
            <div className="row gap2 wrap">
              <Badge tone={f.finding.basis === 'inference' ? 'info' : ''}>{f.finding.basis}</Badge>
              <Badge tone={STATUS_TONE[f.finding.status]}>{f.finding.status.replace('_', ' ')}</Badge>
              <Badge outline title="Verdict of the skeptic agent">
                skeptic: {verdict}
              </Badge>
            </div>
            <p className="home-finding-text">{tidyNumbers(f.finding.statement)}</p>
            <div className="tiny dim">
              {(f.finding.facts ?? []).length} number(s) tied to result cells · {(f.finding.skepticNotes ?? []).length} skeptic note(s) · {formatAge(f.createdAt)}
            </div>
            <Link className="link small" href={`/w/${f.workspaceId}/runs/${f.runId}`}>
              See the evidence →
            </Link>
          </article>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ how it works */

function HowItWorks() {
  const steps = [
    { icon: <Sparkles size={18} />, t: 'Ask', d: 'Type a question in plain English. Nearesis drafts a plan: which certified metrics to query, the charts to draw and the cost. You approve it.' },
    { icon: <Workflow size={18} />, t: 'Agents investigate', d: 'Agents query real NEAR data, build the charts, and an analyst writes findings where every number is tied to a result cell. A skeptic agent then challenges each one.' },
    { icon: <ShieldCheck size={18} />, t: 'Publish proof', d: 'Freeze the evidence into a capsule anyone can rebuild offline, with its hash committed on NEAR testnet.' },
  ];
  return (
    <div className="home-steps">
      {steps.map((s, i) => (
        <div key={s.t} className="home-step">
          <span className="home-step-n mono">0{i + 1}</span>
          <span className="home-step-i">{s.icon}</span>
          <div className="h3">{s.t}</div>
          <p className="small dim">{s.d}</p>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function HomeView() {
  return (
    <div className="col gap4" data-testid="home-view">
      <section className="home-hero">
        <span className="home-eyebrow">
          <Radio size={12} /> Live NEAR research, with receipts
        </span>
        <h1 className="home-title">Ask anything about NEAR. Get answers you can check.</h1>
        <p className="home-sub">
          Agents query a year of real on-chain and NEAR Intents data, chart it, explain what it shows and argue against themselves. Every number links back to the
          query that produced it.
        </p>
        <AskBox />
      </section>

      <LiveStrip />

      <section>
        <SectionBar title="NEAR right now" number="001" />
        <Numbers />
      </section>

      <section>
        <SectionBar title="What the agents found" number="002" />
        <p className="small dim" style={{ marginBottom: 12 }}>
          Recent findings from investigations in your workspaces. Each one was written by the analyst agent from actual result rows and reviewed by the skeptic agent.
        </p>
        <Findings />
      </section>

      <section>
        <SectionBar title="How it works" number="003" />
        <HowItWorks />
      </section>
    </div>
  );
}

