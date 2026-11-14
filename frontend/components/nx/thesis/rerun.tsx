'use client';

import './thesis.css';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { GitCompareArrows } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { Button } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { savePrefs } from '@/lib/agent/prefs';
import { formatUtc } from '@/lib/format';
import { cell, rerunView, type RerunView } from '@/lib/thesis/rerun';
import type { ThesisBundle } from '@/lib/thesis/api';

const enc = encodeURIComponent;

type State = { status: 'idle' } | { status: 'running' } | { status: 'done'; view: RerunView } | { status: 'notServed' } | { status: 'offline'; commands: string[] } | { status: 'error'; error: unknown };

/** The deterministic re-run: `POST /v1/theses/:id/rerun`. State lives with the page so the actions bar and the stage share it. */
export function useRerun(b: ThesisBundle) {
  const qc = useQueryClient();
  const [state, setState] = useState<State>({ status: 'idle' });
  const id = b.summary.id;
  const reference = b.summary.kind === 'reference';
  async function run() {
    if (reference) {
      setState({ status: 'offline', commands: [b.doc.reproduce?.command, b.doc.reproduce?.check].filter((c): c is string => !!c) });
      return;
    }
    setState({ status: 'running' });
    try {
      const raw = await browserApi.send<unknown>('POST', `/v1/theses/${enc(id)}/rerun`);
      setState({ status: 'done', view: rerunView(raw) });
      await qc.invalidateQueries({ queryKey: ['thesis'] });
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 405)) setState({ status: 'notServed' });
      else if (e instanceof ApiRequestError && e.reasonCode === 'REFERENCE_THESIS_OFFLINE') {
        const c = e.detailsObject?.commands;
        setState({ status: 'offline', commands: Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [] });
      } else setState({ status: 'error', error: e });
    }
  }
  return { state, run, pending: state.status === 'running' };
}
export type Rerun = ReturnType<typeof useRerun>;

function Banner({ v }: { v: RerunView }) {
  return (
    <div className="th-rr-banner" data-tone={v.tone || undefined} data-outcome={v.outcome} data-testid="thesis-rerun-banner" role="status">
      <Badge tone={v.tone}>{v.outcome}</Badge>
      <strong>{v.banner}</strong>
    </div>
  );
}

function Rows({ rows, label }: { rows: RerunView['changed']; label: string }) {
  return (
    <div className="th-rr-scroll">
      <table className="th-rr-table" aria-label={label}>
        <thead>
          <tr><th scope="col">What</th><th scope="col">Original</th><th scope="col">Reproduced</th><th scope="col">Change</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const o = cell(r.original, r.what), p = cell(r.reproduced, r.what), d = cell(r.delta, r.what);
            return (
              <tr key={i} data-changed={r.changed || undefined}>
                <th scope="row">{r.what}</th>
                <td className="mono" title={o.exact}>{o.text}</td>
                <td className="mono" title={p.exact}>{p.text}</td>
                <td className="mono" title={d.exact}>{d.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Result({ v }: { v: RerunView }) {
  const [all, setAll] = useState(false);
  const win = v.window && (v.window.from || v.window.to) ? `${v.window.from ?? 'unknown'} to ${v.window.to ?? 'unknown'}` : null;
  return (
    <div className="th-rr-result" data-testid="thesis-rerun-result">
      <Banner v={v} />
      <p className="th-rr-when mono tiny dim" data-testid="thesis-rerun-when">
        {v.ranAt ? `ran ${formatUtc(v.ranAt)}` : 'run time unknown'}
        {win ? ` · dates ${win}` : ''}
        {v.charts !== null ? ` · ${v.charts} ${v.charts === 1 ? 'chart' : 'charts'}` : ''}
        {v.queries !== null ? ` · ${v.queries} ${v.queries === 1 ? 'query' : 'queries'}` : ''}
      </p>
      {v.changed.length > 0 ? (
        <Rows rows={v.changed} label="Numbers that changed" />
      ) : v.changed.length === 0 && v.unchanged.length > 0 ? (
        <p className="small dim">No number changed.</p>
      ) : (
        <p className="small dim">The API returned no comparison rows.</p>
      )}
      {v.unchanged.length > 0 && (
        <>
          <div>
            <Button aria-expanded={all} onClick={() => setAll((x) => !x)} data-testid="thesis-rerun-unchanged-toggle">
              {all ? 'Hide unchanged' : `Show unchanged (${v.unchanged.length})`}
            </Button>
          </div>
          {all && <Rows rows={v.unchanged} label="Numbers that did not change" />}
        </>
      )}
      {v.unavailable.length > 0 && (
        <div data-testid="thesis-rerun-unavailable">
          <div className="label">Could not be re-run ({v.unavailable.length})</div>
          <ul className="th-rr-unavail">
            {v.unavailable.map((u, i) => (
              <li key={i}><b>{u.chart}</b> <span className="dim">{u.reason ?? 'reason unknown'}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The workspace thesis' Reproduce stage head: the free re-run first, the agent re-investigation as the secondary action. */
export function ReproducePanel({ b, rr }: { b: ThesisBundle; rr: Rerun }) {
  const router = useRouter();
  const reference = b.summary.kind === 'reference';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { state } = rr;
  async function again() {
    setPending(true);
    setError(null);
    try {
      const r = await browserApi.send<{ threadId?: string }>('POST', `/v1/theses/${enc(b.summary.id)}/reproduce`);
      if (!r.threadId) throw new Error('The API did not return the thread to open.');
      savePrefs({ threadId: r.threadId, workspaceId: null });
      router.push('/agent');
    } catch (e) {
      setError(e);
      setPending(false);
    }
  }
  return (
    <div className="th-rr" data-testid="thesis-reproduce-panel">
      <div className="th-rr-main">
        <div className="th-rr-act">
          <Button variant="primary" pending={rr.pending} onClick={rr.run} data-testid="thesis-rerun-go">
            <GitCompareArrows size={14} /> Reproduce
          </Button>
          <p className="th-hint">
            {reference ? 'The reference thesis is a file bundle, so it is rebuilt from the repository with the commands below.' : "Re-runs this thesis's own queries on the same dates. Free, no AI involved."}
          </p>
        </div>
        {state.status === 'done' && <Result v={state.view} />}
        {state.status === 'notServed' && (
          <p className="small th-rr-note" data-testid="thesis-rerun-unavailable-api">Reproduce is not available on this API yet. Nothing was run and nothing was charged.</p>
        )}
        {state.status === 'offline' && (
          <div className="th-rr-note" data-testid="thesis-rerun-offline">
            <p className="small">This thesis is a file bundle, so it is reproduced offline, from the repository root.</p>
            {state.commands.length > 0 && <pre className="tt-code" tabIndex={0}><code>{state.commands.join('\n')}</code></pre>}
          </div>
        )}
        {state.status === 'error' && <ApiErrorState error={state.error} onRetry={rr.run} />}
      </div>
      {!reference && (
        <div className="th-rr-second">
          <Button pending={pending} onClick={again} data-testid="thesis-reproduce-go">Re-investigate from scratch</Button>
          <p className="th-hint">Asks the agent the original question again in a new workspace. Uses your credits and may choose different charts, so results can legitimately differ.</p>
          {error ? <ApiErrorState error={error} /> : null}
        </div>
      )}
    </div>
  );
}
