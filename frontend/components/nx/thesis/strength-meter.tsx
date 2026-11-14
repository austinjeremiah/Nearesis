'use client';

import './strength.css';
import { useId, useState } from 'react';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { strengthView, type PartView, type Strength } from '@/lib/thesis/strength';

const R = 15;
const C = 2 * Math.PI * R;

/** A ring with the score inside it; the arc is the score out of 100, coloured by band tone. */
function Ring({ score, tone, size = 40 }: { score: number; tone: string; size?: number }) {
  return (
    <svg className="sm-ring" width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" data-tone={tone || undefined}>
      <circle className="sm-ring-bg" cx="18" cy="18" r={R} fill="none" strokeWidth="3.5" />
      <circle className="sm-ring-fg" cx="18" cy="18" r={R} fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(C * score) / 100} ${C}`} transform="rotate(-90 18 18)" />
      <text x="18" y="22.2" textAnchor="middle" className="sm-ring-n">{score}</text>
    </svg>
  );
}

function Part({ p }: { p: PartView }) {
  return (
    <li className="sm-part" data-full={p.full ? 'true' : 'false'} data-testid="strength-part">
      <span className="sm-mark" aria-hidden="true">{p.full ? <Check size={12} /> : <Minus size={12} />}</span>
      <span className="sm-part-main">
        <span className="sm-part-label">{p.label}</span>
        <span className="sm-part-detail">{p.explain}</span>
      </span>
      <span className="sm-pts mono" aria-label={`${p.points} of ${p.max} points`}>{p.points}/{p.max}</span>
    </li>
  );
}

/** The checklist of parts with points, and why points are missing. */
export function StrengthParts({ strength }: { strength: Strength }) {
  const v = strengthView(strength);
  if (v.parts.length === 0) return <p className="sm-none">The server sent the score without the parts that make it up.</p>;
  return <ul className="sm-parts" aria-label="What the strength score is made of">{v.parts.map((p) => <Part key={p.key} p={p} />)}</ul>;
}

/**
 * Thesis strength. Compact: ring and band word. Expanded: the parts checklist. `expandable` lets the compact form open
 * the checklist in place; `onMore` makes the compact form a button for somewhere else (the Verdict stage). Nothing
 * renders when the API sent no strength.
 */
export default function StrengthMeter({
  strength,
  variant = 'compact',
  expandable = false,
  onMore,
  testId = 'strength-meter',
}: {
  strength: Strength | null | undefined;
  variant?: 'compact' | 'full';
  expandable?: boolean;
  onMore?: () => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  if (!strength) return null;
  const v = strengthView(strength);
  const head = (
    <>
      <Ring score={v.score} tone={v.tone} size={variant === 'full' ? 56 : 36} />
      <span className="sm-text">
        <span className="sm-band" data-tone={v.tone || undefined}>{v.word}</span>
        <span className="sm-sub">{variant === 'full' ? `${v.score} out of 100` : 'strength'}</span>
      </span>
    </>
  );
  if (variant === 'full')
    return (
      <div className="sm sm-full" data-testid={testId} data-band={v.band ?? 'unknown'}>
        <div className="sm-head">{head}</div>
        <p className="sm-lede">{v.missingTotal === 0 && v.parts.length > 0 ? 'Every check passed.' : v.parts.length > 0 ? `${v.missingTotal} ${v.missingTotal === 1 ? 'point is' : 'points are'} missing. Each check below says why.` : 'The checks are not listed.'}</p>
        <StrengthParts strength={strength} />
      </div>
    );
  const label = `Strength ${v.score} out of 100, ${v.word}${onMore ? '. Show how it adds up' : expandable ? '. Show the checks' : ''}`;
  return (
    <div className="sm sm-compact" data-testid={testId} data-band={v.band ?? 'unknown'}>
      {onMore || expandable ? (
        <button type="button" className="sm-btn" aria-label={label} aria-expanded={expandable ? open : undefined} aria-controls={expandable ? panel : undefined} onClick={() => (expandable ? setOpen((o) => !o) : onMore?.())} title="How the strength score adds up">
          {head}
          {expandable && <ChevronDown size={14} aria-hidden="true" className="sm-chev" style={{ transform: open ? 'rotate(180deg)' : undefined }} />}
        </button>
      ) : (
        <span className="sm-static" role="img" aria-label={label}>{head}</span>
      )}
      {expandable && open && (
        <div id={panel} className="sm-pop" data-testid="strength-expanded">
          <StrengthParts strength={strength} />
        </div>
      )}
    </div>
  );
}
