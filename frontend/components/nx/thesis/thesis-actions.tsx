'use client';

import './thesis.css';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, FileDown, GitCompareArrows, Share2, ShieldCheck } from 'lucide-react';
import { Button, Notice } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { savePrefs } from '@/lib/agent/prefs';
import { BUILD_COMMAND, THESIS_MD_HREF } from '@/lib/thesis-track/model';
import { pdfHref, thesisFileHref, thesisKeys, type ThesisBundle } from '@/lib/thesis/api';
import { receiptsText } from '@/lib/thesis/list';
import { checkLabel, verifyView, type VerifyView } from '@/lib/thesis/verify';

const enc = encodeURIComponent;
type Panel = null | 'share' | 'verify' | 'reproduce';

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

function ReproducePanel({ b, onClose }: { b: ThesisBundle; onClose: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reference = b.summary.kind === 'reference';
  async function go() {
    setPending(true);
    setError(null);
    try {
      const r = await browserApi.send<{ threadId?: string; taskId?: string }>('POST', `/v1/theses/${enc(b.summary.id)}/reproduce`);
      if (!r.threadId) throw new Error('The API did not return the thread to open.');
      // The Agent page reopens the thread it was last on; point it at this one, then let the person review and start.
      savePrefs({ threadId: r.threadId, workspaceId: null });
      router.push('/agent');
    } catch (e) {
      setError(e);
      setPending(false);
    }
  }
  if (reference) {
    return (
      <div className="th-panel" data-surface data-testid="thesis-reproduce-panel">
        <h3>Reproduce the reference thesis offline</h3>
        <p>This thesis is a file bundle, so it is rebuilt from the repository, not in your account. Run these from the repository root.</p>
        <pre className="tt-code" tabIndex={0}><code>{`${b.doc.reproduce?.command ?? BUILD_COMMAND}\n${b.doc.reproduce?.check ?? ''}`.trim()}</code></pre>
        <div className="th-panel-actions"><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  return (
    <div className="th-panel" data-surface data-tone="warn" data-testid="thesis-reproduce-panel">
      <h3>Reproduce in my account</h3>
      <p>
        This creates a plan in your Agent tab: a new workspace, the same question, a run, a capsule, a thesis and a comparison against this one. Running it uses your credits. Nothing starts until you review the plan and press Start.
      </p>
      <div className="th-panel-actions">
        <Button variant="primary" pending={pending} onClick={go} data-testid="thesis-reproduce-go">Create the plan</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
      {error ? <ApiErrorState error={error} /> : null}
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
        <Button onClick={() => toggle('reproduce')} aria-expanded={panel === 'reproduce'} data-testid="thesis-reproduce-open">
          <GitCompareArrows size={14} /> Reproduce
        </Button>
        <a className="btn" href={md} download data-testid="thesis-download-md">
          <Download size={14} /> THESIS.md
        </a>
        <a className="btn" href={pdfHref(id)} download data-testid="thesis-download-pdf">
          <FileDown size={14} /> PDF
        </a>
        <span className="th-receipts-strip" data-testid="thesis-receipts-strip">
          {b.receipts ? receiptsText(b.receipts) : 'Receipts are not available yet'}
        </span>
      </div>
      {panel === 'share' && <SharePanel b={b} onClose={() => setPanel(null)} />}
      {panel === 'verify' && <VerifyPanel id={id} onDone={() => setPanel(null)} />}
      {panel === 'reproduce' && <ReproducePanel b={b} onClose={() => setPanel(null)} />}
      {!apiServed && (
        <Notice tone="info" title="Reading the reference from the bundle">
          The thesis API is not serving this thesis yet, so Verify and receipts are unavailable. Everything else works from the bundle.
        </Notice>
      )}
    </div>
  );
}

export { thesisKeys };
