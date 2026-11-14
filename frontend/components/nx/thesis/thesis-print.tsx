'use client';

import './thesis.css';
import { useEffect, useRef, useState } from 'react';
import { ThesisDocView } from '@/components/nx/thesis-track/thesis-view';
import type { Thesis } from '@/lib/thesis-track/model';

/** Print layout of the viewer. The root says `data-thesis-ready="true"` once fonts and every chart are drawn. */
export default function ThesisPrint({ doc, isReference, title }: { doc: Thesis; isReference: boolean; title: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    (async () => {
      try {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]);
      } catch {
        /* fonts API unavailable */
      }
      const settled = () => !!root.current && [...root.current.querySelectorAll<HTMLElement>('[data-report-chart]')].every((c) => c.dataset.ready === 'true');
      while (!stop && !settled() && Date.now() - started < 45_000) await new Promise((r) => setTimeout(r, 100));
      if (!stop) setReady(true);
    })();
    return () => {
      stop = true;
    };
  }, []);
  return (
    <div className="th-pdf-root" ref={root} data-thesis-ready={ready ? 'true' : 'false'} data-thesis-title={title} data-thesis-generated={doc.generatedAt ?? ''}>
      <ThesisDocView doc={doc} print isReference={isReference} publication={null} />
    </div>
  );
}
