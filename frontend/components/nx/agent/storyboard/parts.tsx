'use client';

import { useId, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { fmtTime, fmtValue } from '@/lib/panel/model';
import { plotRuns, xOfTime, yDomainOf, type Series } from '@/lib/agent/storyboard-series';

/** A cream card in the PanelFrame anatomy: bold title row, body, and a quiet mono band at the foot. */
export function SbCard({
  title,
  badges,
  tools,
  children,
  foot,
  id,
  tone,
  hl,
  testId,
  label,
}: {
  title?: ReactNode;
  badges?: ReactNode;
  tools?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
  id?: string;
  tone?: 'bad';
  hl?: boolean;
  testId?: string;
  label?: string;
}) {
  return (
    <article className="sb-card" id={id} data-tone={tone} data-hl={hl ? 'true' : undefined} data-testid={testId} aria-label={label}>
      {(title || badges || tools) && (
        <header className="sb-card-head">
          <div className="sb-card-title">
            {title && <h4>{title}</h4>}
            {badges && <div className="sb-badges">{badges}</div>}
          </div>
          {tools && <div className="sb-card-tools">{tools}</div>}
        </header>
      )}
      {children !== undefined && children !== null && <div className="sb-card-body">{children}</div>}
      {foot && <footer className="sb-card-foot">{foot}</footer>}
    </article>
  );
}

/** A value in mono that can be copied; shows the short form and puts the full value in the tooltip and the clipboard. */
export function CopyChip({ value, short, label }: { value: string; short?: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="sb-copy">
      <span className="mono" title={value}>{short ?? value}</span>
      <button
        type="button"
        className="sb-copy-btn"
        aria-label={done ? `${label} copied` : `Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          } catch {
            /* clipboard unavailable: the full value is in the tooltip */
          }
        }}
      >
        {done ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
    </span>
  );
}

const W = 320;
const H = 96;
const PAD = { t: 8, b: 6, l: 4, r: 4 };

/**
 * A small chart of one series: black line, green wash, mono end labels. A marker is drawn as a vertical line with a pin
 * at its date, a threshold as a dashed horizontal line. Gaps in the data stay gaps. Drawn from the data it is given,
 * never filled in.
 */
export function MiniSeries({
  series,
  markerAt,
  threshold,
  label,
  height = H,
}: {
  series: Series;
  markerAt?: number | null;
  threshold?: { value: number; op: string } | null;
  label: string;
  height?: number;
}) {
  const gid = useId().replace(/:/g, '');
  const pts = series.points;
  const dom = yDomainOf(pts, threshold ? [threshold.value] : []);
  const runs = plotRuns(pts, W, height, PAD, dom);
  const last = [...pts].reverse().find((p) => p.v !== null);
  const y = (v: number) => PAD.t + (1 - (v - dom[0]) / (dom[1] - dom[0] || 1)) * (height - PAD.t - PAD.b);
  const mx = markerAt != null ? xOfTime(pts, markerAt, W, PAD.l, PAD.r) : null;
  const mv = markerAt != null ? nearest(pts, markerAt) : null;
  const first = pts[0]!;
  const end = pts[pts.length - 1]!;
  const vals = pts.map((p) => p.v).filter((v): v is number => v !== null);
  return (
    <figure className="sb-mini" aria-label={label}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id={`g${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.38" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {runs.map((r, i) => (
          <g key={i}>
            <path d={`M${r[0]!.x},${height - PAD.b} ${r.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${r[r.length - 1]!.x},${height - PAD.b} Z`} fill={`url(#g${gid})`} />
            <path d={r.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} fill="none" stroke="var(--text)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {threshold && Number.isFinite(threshold.value) && (
          <line x1={PAD.l} x2={W - PAD.r} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--text)" strokeWidth="1.2" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        )}
        {mx !== null && (
          <g>
            <line x1={mx} x2={mx} y1={PAD.t - 2} y2={height - PAD.b} stroke="var(--text)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
            {mv !== null && <circle cx={mx} cy={y(mv)} r="4.5" fill="var(--accent)" stroke="var(--text)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          </g>
        )}
        {markerAt == null && last && <circle cx={runs[runs.length - 1]![runs[runs.length - 1]!.length - 1]!.x} cy={runs[runs.length - 1]![runs[runs.length - 1]!.length - 1]!.y} r="3.5" fill="var(--accent)" stroke="var(--text)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption className="sb-mini-axis mono">
        <span>{fmtTime(first.t)}</span>
        {vals.length > 0 && <span className="sb-mini-range">{fmtValue(Math.min(...vals), series.unit)} to {fmtValue(Math.max(...vals), series.unit)}</span>}
        <span>{fmtTime(end.t)}</span>
      </figcaption>
    </figure>
  );
}

function nearest(pts: { t: number; v: number | null }[], t: number): number | null {
  let best: { d: number; v: number } | null = null;
  for (const p of pts) {
    if (p.v === null) continue;
    const d = Math.abs(p.t - t);
    if (!best || d < best.d) best = { d, v: p.v };
  }
  return best?.v ?? null;
}
