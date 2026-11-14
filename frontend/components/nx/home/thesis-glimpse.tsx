'use client';

import Link from 'next/link';
import { ArrowRight, FileText } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { Skeleton } from '@/components/nx/ui';
import { useApiGet } from '@/components/nx/data/kit';
import StrengthMeter from '@/components/nx/thesis/strength-meter';
import { normalizeStrength } from '@/lib/thesis/strength';

const REF = 'reference-near-intents';

type Series = { id?: string; last30?: number | null; label?: string };
type SplitRow = { key?: string; centsPer100Usd?: { last30?: number | null; plus365?: { central?: number | null } | null } };
type Detail = {
  thesis?: { title?: string; hypothesis?: string; strength?: unknown; verdict?: { status?: string } | string };
  doc?: {
    title?: string;
    question?: string;
    hypothesis?: string;
    verdict?: { status?: string };
    forecast?: { series?: Series[]; derived?: { toll_split?: { rows?: SplitRow[] } } };
  };
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Cents per 100 dollars, read for people: two significant digits below one cent, one decimal above. */
function cents(v: number | null): string {
  if (v === null) return 'unknown';
  if (v < 1) return `${Number(v.toPrecision(2))}¢`;
  return `${v.toFixed(1)}¢`;
}
const pct = (v: number | null): string => (v === null ? 'unknown' : `${(v * 100).toFixed(1)}%`);
const thousands = (v: number | null): string => (v === null ? 'unknown' : `${(v / 1000).toFixed(1)}k`);

/** A glimpse of the reference thesis for the Home page: the claim, the toll it measures as a picture, and a way in. */
export default function ThesisGlimpse() {
  const q = useApiGet<Detail>(`/v1/theses/${REF}`);
  if (q.isPending)
    return (
      <section className="home-glimpse surface" data-surface aria-busy="true">
        <Skeleton rows={8} />
      </section>
    );
  const d = q.data;
  const doc = d?.doc;
  const title = doc?.title ?? d?.thesis?.title ?? 'NEAR thesis';
  const claim = doc?.hypothesis ?? d?.thesis?.hypothesis ?? null;
  const status = doc?.verdict?.status ?? (typeof d?.thesis?.verdict === 'string' ? d.thesis.verdict : d?.thesis?.verdict?.status) ?? null;
  const strength = normalizeStrength(d?.thesis?.strength);
  const rows = doc?.forecast?.derived?.toll_split?.rows ?? [];
  const row = (k: string) => rows.find((r) => r.key === k)?.centsPer100Usd ?? null;
  const pay = num(row('spread')?.last30);
  const keep = num(row('burn')?.last30);
  const apps = num(row('app_fees')?.last30);
  const series = doc?.forecast?.series ?? [];
  const s = (id: string) => num(series.find((x) => x.id === id)?.last30);
  // The bar is drawn to scale: NEAR's share is so small that it gets a minimum visible width, and says so.
  const keepWidth = pay && keep !== null ? Math.max(0.6, (keep / pay) * 100) : 0;
  const appsWidth = pay && apps !== null ? Math.min(100, (apps / pay) * 100) : 0;

  return (
    <section className="home-glimpse surface" data-surface data-testid="home-thesis-glimpse">
      <div className="home-glimpse-head">
        <span className="home-eyebrow">Reference thesis</span>
        {status && <Badge tone="info">{status.replace(/_/g, ' ').toLowerCase()}</Badge>}
      </div>
      <h1 className="home-glimpse-title">{title}</h1>
      {claim && <p className="home-glimpse-claim">{claim}</p>}

      <div className="home-toll" aria-label="Per 100 dollars settled through NEAR Intents">
        <p className="home-toll-k">Per 100 dollars settled through NEAR Intents, last 30 days</p>
        <div className="home-toll-row">
          <span className="home-toll-label">Users pay</span>
          <div className="home-toll-bar" role="img" aria-label={`Users pay ${cents(pay)}, of which app fees ${cents(apps)}`}>
            <span className="home-toll-fill pay" style={{ width: pay ? '100%' : 0 }} />
            {apps !== null && <span className="home-toll-fill apps" style={{ width: `${appsWidth}%` }} />}
          </div>
          <span className="home-toll-v">{cents(pay)}</span>
        </div>
        <div className="home-toll-row">
          <span className="home-toll-label">NEAR keeps</span>
          <div className="home-toll-bar" role="img" aria-label={`NEAR keeps ${cents(keep)} as gas burnt`}>
            <span className="home-toll-fill keep" style={{ width: `${keepWidth}%` }} />
          </div>
          <span className="home-toll-v keep">{cents(keep)}</span>
        </div>
        <p className="home-toll-note">
          Bars to scale. The darker part of “users pay” is integrator app fees ({cents(apps)}); NEAR’s line is drawn at a minimum width so it is visible at all.
        </p>
      </div>

      <div className="home-glimpse-stats">
        <div>
          <span className="home-glimpse-v">{pct(s('no_near_share'))}</span>
          <span className="home-glimpse-l">of settled value touches no NEAR asset</span>
        </div>
        <div>
          <span className="home-glimpse-v">{pct(s('stable_share'))}</span>
          <span className="home-glimpse-l">is stablecoin to stablecoin</span>
        </div>
        <div>
          <span className="home-glimpse-v">{pct(s('near_token_share'))}</span>
          <span className="home-glimpse-l">has the NEAR token on either side</span>
        </div>
        <div>
          <span className="home-glimpse-v">{thousands(s('tail_signers'))}</span>
          <span className="home-glimpse-l">ordinary NEAR accounts active a day</span>
        </div>
      </div>

      <div className="home-glimpse-foot">
        {strength && <StrengthMeter strength={strength} />}
        <div className="home-glimpse-actions">
          <Link href={`/thesis/${REF}`} className="btn primary lg" data-testid="home-thesis-link">
            Read the full thesis <ArrowRight size={14} />
          </Link>
          <Link href={`/thesis/${REF}/document`} className="btn lg">
            <FileText size={14} /> Document view
          </Link>
        </div>
      </div>
      {q.isError && <p className="small dim">The thesis could not be loaded right now; the full thesis page has it.</p>}
    </section>
  );
}
