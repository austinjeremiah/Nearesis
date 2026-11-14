'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/nx/evidence';
import { Modal } from '@/components/nx/overlays';
import { Button, KeyValues } from '@/components/nx/ui';
import type { HashView, ProvenanceView } from '@/lib/panel/provenance';
import './panel.css';

function useCopy(value: string) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard unavailable: the value stays selectable */
    }
  };
  return { done, copy };
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { done, copy } = useCopy(value);
  return (
    <Button variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copy()}>
      {done ? 'Copied' : 'Copy'}
    </Button>
  );
}

function HashRow({ h, label }: { h: HashView; label: string }) {
  return (
    <span className="row gap2 wrap nxp-hashrow">
      <span className="nxp-hash" title={h.full} data-testid={`pv-${label.toLowerCase().replace(/ /g, '-')}`}>{h.short}</span>
      <CopyButton value={h.full} label={label.toLowerCase()} />
    </span>
  );
}

const NR = <span className="dim">not recorded</span>;

/**
 * "Query and provenance": a popup with only what a panel was asked and where its numbers came from. No chart, no tabs and
 * nothing editable. `pageHref` adds a secondary link to the full panel page.
 */
export function ProvenanceDialog({
  open,
  onOpenChange,
  view,
  pageHref,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  view: ProvenanceView;
  pageHref?: string;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const q = useCopy(view.queryText ?? '');
  const m = view.metric;
  const cov = view.coverage;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={view.title}
      description="Query and provenance"
      wide
      onCloseAutoFocus={onCloseAutoFocus}
      footer={
        <>
          {pageHref && <Link className="link small" href={pageHref} data-testid="pv-page-link">Open full panel page</Link>}
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </>
      }
    >
      <div className="col gap3 nxp-pv" data-testid="provenance-popup">
        <section aria-label={view.queryLabel}>
          <div className="row between gap2" style={{ alignItems: 'center' }}>
            <h3 className="label" style={{ margin: 0 }}>{view.queryLabel}, as stored</h3>
            {view.queryText !== null && (
              <Button variant="ghost" aria-label="Copy the query" onClick={() => void q.copy()} data-testid="pv-copy-query">
                {q.done ? 'Copied' : 'Copy'}
              </Button>
            )}
          </div>
          {view.queryText !== null ? <pre className="nxp-pre" tabIndex={0} aria-label={view.queryLabel} data-testid="pv-query">{view.queryText}</pre> : <p className="small dim" data-testid="pv-query-note">{view.queryNote}</p>}
        </section>
        <KeyValues
          rows={[
            { k: 'Source', v: view.sources.length ? <span className="row gap2 wrap">{view.sourceLabel && <Badge outline>{view.sourceLabel}</Badge>}<span className="mono">{view.sources.join(', ')}</span></span> : view.sourceLabel ? <Badge outline>{view.sourceLabel}</Badge> : NR },
            { k: 'Time window', v: view.window ? <span className="mono">{view.window}</span> : NR },
            { k: 'Metric', v: m.name ? <span className="mono">{m.name}</span> : NR },
            { k: 'Metric version', v: m.version ? <span className="mono">{m.version}</span> : NR },
            { k: 'Status', v: <span className="row gap2 wrap"><Badge tone={m.certification.startsWith('Certified') ? 'ok' : m.certification.startsWith('Analytics') ? 'info' : 'warn'}>{m.certification}</Badge>{m.status && <Badge outline tone="warn">{m.status}</Badge>}</span> },
            { k: 'Coverage', v: <Badge tone={cov.state === 'complete' ? 'ok' : 'warn'}>{cov.state}</Badge> },
            { k: 'Freshness', v: <span>{view.freshness.label}{view.freshness.asOf ? <> · as of <span className="mono">{view.freshness.asOf}</span></> : ' · as of unknown'}</span> },
            { k: 'Rows', v: view.rowCount !== null ? <span className="mono">{view.rowCount.toLocaleString('en-US')}{view.rowsNote ? ` ${view.rowsNote}` : ''}</span> : NR },
            { k: 'Result hash', v: view.resultHash ? <HashRow h={view.resultHash} label="Result hash" /> : NR },
            { k: 'Query hash', v: view.queryHash ? <HashRow h={view.queryHash} label="Query hash" /> : NR },
          ]}
        />
        {(cov.lines.length > 0 || cov.gaps.length > 0) && (
          <section aria-label="Coverage details">
            <h3 className="label" style={{ margin: 0 }}>Coverage details</h3>
            <ul className="small nxp-pv-list">
              {cov.lines.map((l, i) => <li key={`l${i}`}>{l}</li>)}
              {cov.gaps.slice(0, 20).map((g, i) => <li key={`g${i}`}><span className="mono">{g}</span></li>)}
              {cov.gaps.length > 20 && <li>and {cov.gaps.length - 20} more gaps</li>}
            </ul>
          </section>
        )}
        <section aria-label="Caveats">
          <h3 className="label" style={{ margin: 0 }}>Caveats</h3>
          {view.caveats.length ? (
            <ul className="small nxp-pv-list" data-testid="pv-caveats">{view.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          ) : (
            <p className="small dim">None reported.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}
