'use client';

import './flow.css';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';

/**
 * Small shared pieces of the "flow" layout: a sticky rail of pills, numbered stages on a vertical line, cream cards and
 * stat tiles. They follow the Agent storyboard's anatomy (same tokens, same pill and spine shapes) so the Agent page can
 * adopt them later; nothing here knows about theses.
 */

export type FlowDot = 'done' | 'ok' | 'warn' | 'bad' | 'info' | 'idle';
export type FlowItem = { id: string; label: string; dot?: FlowDot };

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

/** Which stage is under the reading line. `go(id)` scrolls to a stage and marks it active immediately. */
export function useFlowSpy(ids: string[], enabled = true): { active: string; go: (id: string) => void } {
  const [active, setActive] = useState(ids[0] ?? '');
  const lock = useRef(0);
  const key = ids.join('|');
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (els.length === 0) return;
    const root = scrollParentOf(els[0]!);
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Number.POSITIVE_INFINITY);
        if (Date.now() < lock.current) return;
        const open = [...seen.entries()].filter(([, t]) => Number.isFinite(t)).sort((a, b) => a[1] - b[1]);
        if (open[0]) setActive(open[0][0]);
      },
      { root, rootMargin: '-96px 0px -62% 0px', threshold: 0 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  const go = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    lock.current = Date.now() + 900;
    setActive(id);
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, []);
  return { active, go };
}

export function FlowRail({ items, active, onSelect, label }: { items: FlowItem[]; active: string; onSelect: (id: string) => void; label: string }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // keep the active pill in view when the rail scrolls sideways
    const pill = ref.current?.querySelector<HTMLElement>('[aria-current="step"]');
    const box = ref.current?.parentElement;
    if (pill && box && box.scrollWidth > box.clientWidth) box.scrollTo({ left: pill.offsetLeft - 24, behavior: 'smooth' });
  }, [active]);
  return (
    <nav className="fl-rail" aria-label={label} data-testid="flow-rail">
      <ol ref={ref}>
        {items.map((it) => (
          <li key={it.id}>
            <button type="button" className="fl-pill" data-s={it.dot ?? 'idle'} aria-current={active === it.id ? 'step' : undefined} onClick={() => onSelect(it.id)}>
              <span className="fl-pill-dot" aria-hidden="true" />
              {it.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function FlowStages({ children }: { children: ReactNode }) {
  return <ol className="fl-stages">{children}</ol>;
}

export function FlowStage({
  id,
  n,
  title,
  badge,
  note,
  tone,
  children,
}: {
  id: string;
  n: number;
  title: string;
  badge?: ReactNode;
  note?: ReactNode;
  tone?: FlowDot;
  children: ReactNode;
}) {
  return (
    <li className="fl-stage" id={id} data-s={tone ?? 'idle'}>
      <div className="fl-spine" aria-hidden="true">
        <span className="fl-node">{n}</span>
      </div>
      <div className="fl-stage-main">
        <header className="fl-stage-head">
          <div className="fl-stage-titles">
            <h2 className="fl-stage-title">{title}</h2>
            {badge}
          </div>
          {note && <p className="fl-stage-note mono">{note}</p>}
        </header>
        <div className="fl-stage-body">{children}</div>
      </div>
    </li>
  );
}

export function FlowCard({
  title,
  badges,
  tools,
  foot,
  tone,
  children,
  className = '',
  testid,
}: {
  title?: ReactNode;
  badges?: ReactNode;
  tools?: ReactNode;
  foot?: ReactNode;
  tone?: 'ok' | 'bad' | 'warn' | 'info';
  children?: ReactNode;
  className?: string;
  testid?: string;
}) {
  return (
    <section className={`fl-card ${className}`.trim()} data-surface data-tone={tone} data-testid={testid}>
      {(title || badges || tools) && (
        <div className="fl-card-head">
          <div className="fl-card-title">
            {title && <h3>{title}</h3>}
            {badges && <div className="fl-badges">{badges}</div>}
          </div>
          {tools && <div className="fl-card-tools">{tools}</div>}
        </div>
      )}
      {children !== undefined && children !== null && <div className="fl-card-body">{children}</div>}
      {foot && <div className="fl-card-foot mono">{foot}</div>}
    </section>
  );
}

export function StatTile({ label, value, sub, tone, hint, exact, small }: { label: string; value: string; sub?: string | null; tone?: 'ok' | 'bad' | 'warn' | 'info' | ''; hint?: string | null; exact?: string | null; small?: boolean }) {
  return (
    <div className="fl-tile" data-surface data-tone={tone || undefined}>
      <span className="fl-tile-label">{label}</span>
      {hint && <span className="fl-tile-hint">{hint}</span>}
      <span className="fl-tile-value mono" title={exact && exact !== value ? exact : undefined} data-small={small || undefined}>{value}</span>
      {sub && <span className="fl-tile-sub mono">{sub}</span>}
    </div>
  );
}

/** Content capped to a height with a fade and a Show all toggle; the toggle only appears when something is cut. */
export function Clamp({ children, lines = 11, all = false, label = 'Show all' }: { children: ReactNode; lines?: number; all?: boolean; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 4);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [children, open]);
  const free = all || open;
  return (
    <div className="fl-clamp" data-open={free} data-cut={cut && !free}>
      <div ref={box} className="fl-clamp-box" style={free ? undefined : { maxHeight: `${lines * 1.55}em` }}>
        {children}
      </div>
      {!all && (cut || open) && (
        <button type="button" className="fl-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} /> {open ? 'Show less' : label}
        </button>
      )}
    </div>
  );
}

/** A disclosure that is a button, not a bare summary: same look as the pills' small cousins. */
export function Disclose({ label, openLabel, defaultOpen = false, children }: { label: string; openLabel?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="fl-disc">
      <button type="button" className="fl-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : undefined }} /> {open ? (openLabel ?? label) : label}
      </button>
      {open && <div className="fl-disc-body">{children}</div>}
    </div>
  );
}

export function FlowHero({
  title,
  badge,
  meta,
  actions,
  eyebrow,
}: {
  title: string;
  badge?: ReactNode;
  meta?: ReactNode[];
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="fl-hero">
      {eyebrow && <div className="fl-hero-eyebrow">{eyebrow}</div>}
      <div className="fl-hero-row">
        <h1 className="fl-hero-title">{title}</h1>
        {badge && <div className="fl-hero-badge">{badge}</div>}
      </div>
      {meta && meta.length > 0 && (
        <p className="fl-hero-meta mono">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </p>
      )}
      <div className="fl-meter" aria-hidden="true"><span /></div>
      {actions}
    </header>
  );
}

export { Badge };
