'use client';

import './thesis.css';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Check, Copy, Download, FileDown, FileText, GitCompareArrows, Share2, ShieldCheck } from 'lucide-react';
import { Button, Notice } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { THESIS_MD_HREF } from '@/lib/thesis-track/model';
import { pdfHref, thesisFileHref, thesisKeys, type ThesisBundle } from '@/lib/thesis/api';
import { thesisDocHref } from '@/lib/thesis/document';
import { receiptParts, receiptTotal, receiptsText } from '@/lib/thesis/list';
import { checkLabel, verifyView, type VerifyView } from '@/lib/thesis/verify';
import { ChallengeButton } from './challenges';

const enc = encodeURIComponent;
type Panel = null | 'share' | 'verify';

function CopyLink({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="th-link">
      <code data-testid="thesis-share-link">{text}</code>
      <Button
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1800);
          } catch {
            /* clipboard blocked: the link is selectable above */
          }
        }}
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
        {done ? 'Copied' : 'Copy link'}
      </Button>
    </div>
  );
}

function SharePanel({ b, onClose }: { b: ThesisBundle; onClose: () => void }) {
  const qc = useQueryClient();
  const [slug, setSlug] = useState<string | null>(b.summary.shareSlug && b.summary.published ? b.summary.shareSlug : null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const url = slug && typeof window !== 'undefined' ? `${window.location.origin}/t/${slug}` : slug ? `/t/${slug}` : null;
  async function publish() {
    setPending(true);
    setError(null);
    try {
      const r = await browserApi.send<{ shareSlug?: string; publicUrlPath?: string }>('POST', `/v1/theses/${enc(b.summary.id)}/publish`);
      const s = r.shareSlug ?? r.publicUrlPath?.replace(/^\/t\//, '') ?? null;
      if (!s) throw new Error('The API did not return a share link.');
      setSlug(s);
      await qc.invalidateQueries({ queryKey: ['thesis'] });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  async function unpublish() {
    setPending(true);
    setError(null);
    try {
      await browserApi.send('POST', `/v1/theses/${enc(b.summary.id)}/unpublish`);
      setSlug(null);
      await qc.invalidateQueries({ queryKey: ['thesis'] });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="th-panel" data-surface data-testid="thesis-share-panel">
      {slug && url ? (
        <>
          <h3>This thesis is public</h3>
          <p>Anyone with this link can read it without signing in. Signed-in readers can verify it and reproduce it in their own account.</p>
          <CopyLink text={url} label="share link" />
          <div className="th-panel-actions">
            <Button pending={pending} onClick={unpublish}>Stop sharing</Button>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </>
      ) : (
        <>
          <h3>Make this thesis public?</h3>
          <p>
            Publishing creates a link that anyone can open without signing in. What becomes public: the hypothesis, the verdict, the evidence for and against, every chart with its query and data, the capsule hashes, and your display name. What stays private: your workspace, your other work and your account ids. You can stop sharing at any time.
          </p>
          <div className="th-panel-actions">
            <Button variant="primary" pending={pending} onClick={publish} data-testid="thesis-publish">Publish and get the link</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
      {error ? <ApiErrorState error={error} /> : null}
    </div>
  );
}

function VerifyPanel({ id, onDone }: { id: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<VerifyView | null>(null);
  async function run() {
    setPending(true);
    setError(null);
    try {
      setView(verifyView(await browserApi.send<unknown>('POST', `/v1/theses/${enc(id)}/verify`)));
      await qc.invalidateQueries({ queryKey: ['thesis'] });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="th-panel" data-surface data-tone={view ? (view.outcome === 'verified' ? undefined : 'bad') : undefined} data-testid="thesis-verify-panel">
      <h3>Verify</h3>
      <p className="th-hint">Re-checks the document hash, every chart&apos;s data hash and the frozen series, and recomputes the test numbers. It is free: no model and no chain call.</p>
      {!view && (
        <div className="th-panel-actions">
          <Button variant="primary" pending={pending} onClick={run} data-testid="thesis-verify-run">Run the checks</Button>
          <Button variant="ghost" onClick={onDone}>Close</Button>
        </div>
      )}
      {error ? <ApiErrorState error={error} onRetry={run} /> : null}
      {view && (
        <>
          <p>
            <Badge tone={view.outcome === 'verified' ? 'ok' : 'bad'}>{view.outcome}</Badge> <span data-testid="thesis-verify-summary">{view.summary}</span>
          </p>
          <ul className="th-checks" data-testid="thesis-verify-checks">
            {view.checks.map((c, i) => (
              <li key={i} data-ok={c.ok}>
                <Badge tone={c.ok ? 'ok' : 'bad'} outline>{c.ok ? 'pass' : 'fail'}</Badge>
                <span>{checkLabel(c.name)}</span>
                {c.detail && <span className="mono">{c.detail}</span>}
              </li>
            ))}
          </ul>
          <div className="th-panel-actions">
            <Button onClick={run} pending={pending}>Run again</Button>
            <Button variant="ghost" onClick={onDone}>Close</Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Actions bar for a thesis the reader can open in the app: share, verify, reproduce, downloads, receipts. */
export default function ThesisActions({ b }: { b: ThesisBundle }) {
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));
  const reference = b.summary.kind === 'reference';
  const id = b.summary.id;
  const md = b.source === 'api' ? thesisFileHref(id, 'THESIS.md') : THESIS_MD_HREF;
  const apiServed = b.source === 'api';
  return (
    <div className="th-actions" data-testid="thesis-actions">
      <div className="th-actions-row">
        {!reference && (
          <Button variant="primary" onClick={() => toggle('share')} aria-expanded={panel === 'share'} data-testid="thesis-share">
            <Share2 size={14} /> {b.summary.published ? 'Share link' : 'Share'}
          </Button>
        )}
        <Button onClick={() => toggle('verify')} aria-expanded={panel === 'verify'} disabled={!apiServed} disabledReason="Verification is served by the thesis API, which is not available yet." data-testid="thesis-verify">
          <ShieldCheck size={14} /> Verify
        </Button>
        <Button onClick={() => { document.getElementById('th-reproduce')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.getElementById('th-reproduce')?.querySelector<HTMLElement>('[data-testid="thesis-rerun-go"]')?.focus({ preventScroll: true }); }} title="Re-runs this thesis's own queries on the same dates. Free, no AI involved." data-testid="thesis-reproduce-open">
          <GitCompareArrows size={14} /> Reproduce
        </Button>
        {apiServed && <ChallengeButton thesisId={id} />}
        <a className="btn" href={md} download data-testid="thesis-download-md">
          <Download size={14} /> THESIS.md
        </a>
        <a className="btn" href={pdfHref(id)} download data-testid="thesis-download-pdf">
          <FileDown size={14} /> PDF
        </a>
        <Link className="btn" href={thesisDocHref(id)} data-testid="thesis-document-view">
          <FileText size={14} /> Document view
        </Link>
        <span className="th-receipts-strip" data-testid="thesis-receipts-strip">
          {!b.receipts
            ? 'Receipts are not available yet'
            : receiptTotal(b.receipts) === 0
              ? receiptsText(b.receipts)
              : receiptParts(b.receipts).map((p, i) => (
                  <span key={p.text} data-warn={p.warn || undefined}>{i > 0 ? ' · ' : ''}{p.text}</span>
                ))}
        </span>
      </div>
      {panel === 'share' && <SharePanel b={b} onClose={() => setPanel(null)} />}
      {panel === 'verify' && <VerifyPanel id={id} onDone={() => setPanel(null)} />}
      {!apiServed && (
        <Notice tone="info" title="Reading the reference from the bundle">
          The thesis API is not serving this thesis yet, so Verify and receipts are unavailable. Everything else works from the bundle.
        </Notice>
      )}
    </div>
  );
}

export { thesisKeys };
