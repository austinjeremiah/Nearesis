'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * Pieces both A4 documents (the workspace report and the thesis document) draw with, so they share one stylesheet
 * (`report.css`) and one look.
 */

const STATUS_TONE: Record<string, string> = { supported: 'ok', mixed: 'warn', insufficient_data: 'neutral', cannot_compute: 'bad', verified: 'ok', reproduced: 'ok', published: 'ok', failed: 'bad', not_attested: 'warn' };

export const Tag = ({ tone, children, title }: { tone?: string; children: ReactNode; title?: string }) => (
  <span className={`rp-tag ${STATUS_TONE[String(tone)] ?? tone ?? 'neutral'}`} title={title}>
    {children}
  </span>
);

export function Section({ n, title, children, id, newPage = true }: { n: string; title: string; children: ReactNode; id?: string; newPage?: boolean }) {
  return (
    <section className={`rp-sec${newPage ? ' rp-newpage' : ''}`} id={id}>
      <header className="rp-sec-h">
        <span className="rp-sec-n">{n}</span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function Stat({ k, v, sub, exact, className }: { k: string; v: ReactNode; sub?: ReactNode; exact?: string; className?: string }) {
  return (
    <div className={`rp-stat${className ? ` ${className}` : ''}`}>
      <span className="rp-stat-k">{k}</span>
      <span className="rp-stat-v" title={exact}>{v}</span>
      {sub && <span className="rp-stat-s">{sub}</span>}
    </div>
  );
}

/** Wait until fonts and every chart are settled, then flag the document for the PDF renderer. */
export function useReady(): [RefObject<HTMLDivElement | null>, boolean] {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      try {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
      } catch {
        /* fonts API unavailable */
      }
      const settled = () => !stop && !!root.current && [...root.current.querySelectorAll<HTMLElement>('[data-report-chart]')].every((c) => c.dataset.ready === 'true');
      while (!stop && !settled() && Date.now() - started < 45_000) await new Promise((r) => setTimeout(r, 100));
      if (!stop) setReady(true);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, []);
  return [root, ready];
}
