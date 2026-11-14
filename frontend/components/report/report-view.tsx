'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Wordmark from '@/components/Wordmark';
import { ReportChart } from '@/components/report/report-chart';
import { formatNear } from '@/lib/near/units';
import { formatUtc, shortHash } from '@/lib/format';
import { tidyNumbers } from '@/lib/prose';
import {
  TABLE_ROW_CAP,
  executiveSummary,
  hasContent,
  moreRows,
  nearblocksTx,
  panelDraw,
  panelTable,
  panelTitle,
  panelsOfRun,
  pdfFilename,
} from '@/lib/report/model';
import type { CostEntry, ReportCapsule, ReportDoc, ReportFinding, ReportPanel, ReportProof, ReportRun } from '@/lib/report/types';

const dash = '—';
const day = (iso: string | null | undefined) => (iso ? formatUtc(iso, false) : dash);
const cell = (v: string | number | null): string => (v === null ? dash : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(v));
const label = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : dash);

const STATUS_TONE: Record<string, string> = { supported: 'ok', mixed: 'warn', insufficient_data: 'neutral', cannot_compute: 'bad', verified: 'ok', reproduced: 'ok', published: 'ok', failed: 'bad', not_attested: 'warn' };
const Tag = ({ tone, children }: { tone?: string; children: ReactNode }) => <span className={`rp-tag ${STATUS_TONE[String(tone)] ?? tone ?? 'neutral'}`}>{children}</span>;

function Section({ n, title, children, id, newPage = true }: { n: string; title: string; children: ReactNode; id?: string; newPage?: boolean }) {
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

function Table({ columns, rows, more, mono = true }: { columns: { name: string; unit?: string | null }[]; rows: (string | number | null)[][]; more: number; mono?: boolean }) {
  return (
    <div className="rp-tablewrap">
      <table className="rp-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={i > 0 ? 'num' : ''}>
                {c.name}
                {c.unit ? <span className="rp-unit"> {c.unit}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((v, ci) => (
                <td key={ci} className={`${ci > 0 && typeof v === 'number' ? 'num' : ''}${mono ? ' mono' : ''}${typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? ' nw' : ''}`}>
                  {cell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && <p className="rp-more">{moreRows(more)}</p>}
    </div>
  );
}

function PanelCard({ p }: { p: ReportPanel }) {
  const d = panelDraw(p);
  const title = panelTitle(p);
  const tbl = d.type === 'bar' ? panelTable(p, 12) : null;
  return (
    <figure className="rp-card rp-panel" data-panel={p.hash}>
      <figcaption>
        <span className="rp-panel-t">{title}</span>
        <span className="rp-panel-k">{p.kind ? label(p.kind) : 'panel'}</span>
      </figcaption>
      <p className="rp-meta">
        {p.unit && <span>unit <b>{p.unit}</b></span>}
        {p.source && <span>source <b>{p.source}</b></span>}
        {p.window && <span>window <b>{day(p.window.from)} to {day(p.window.to)}</b></span>}
        {p.metricVersion && <span>metric <b>{p.metricVersion}</b></span>}
        {p.coverage?.state && <span>coverage <b>{label(p.coverage.state)}{p.coverage.gaps ? `, ${p.coverage.gaps} gap(s)` : ''}</b></span>}
      </p>
      {d.type === 'none' && <p className="rp-empty">{d.reason}</p>}
      {(d.type === 'line' || d.type === 'bar') && (
        <>
          <ReportChart type={d.type} x={d.x} series={d.series} unit={d.series[0]?.unit ?? null} ariaLabel={`${title}, ${d.rowCount} points`} height={d.type === 'bar' ? 210 : 180} />
          <p className="rp-foot">
            {d.rowCount.toLocaleString('en-US')} {d.type === 'bar' ? 'bars' : 'points'}; a missing value is a gap, never zero.
          </p>
        </>
      )}
      {d.type === 'table' && (
        <>
          <Table columns={d.columns} rows={d.rows} more={d.more} />
          <p className="rp-foot">Table of {d.rowCount.toLocaleString('en-US')} rows (first {Math.min(TABLE_ROW_CAP, d.rowCount)} shown).</p>
        </>
      )}
      {tbl && <Table columns={tbl.columns} rows={tbl.rows} more={tbl.more} />}
      {p.caveats.length > 0 && (
        <ul className="rp-caveats">
          {p.caveats.map((c, i) => (
            <li key={i}>{tidyNumbers(c)}</li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function FindingCard({ f }: { f: ReportFinding }) {
  const notes = f.skepticNotes ?? [];
  return (
    <article className="rp-card rp-finding">
      <div className="rp-tags">
        {f.basis && <Tag tone="info">{f.basis}</Tag>}
        <Tag tone={f.status}>{label(f.status)}</Tag>
        <Tag tone={f.skepticDegraded ? 'warn' : 'neutral'}>{f.skepticDegraded ? 'skeptic review degraded' : notes.length ? `skeptic: ${notes.length} note${notes.length === 1 ? '' : 's'}` : 'skeptic: no notes returned'}</Tag>
      </div>
      <p className="rp-statement">{tidyNumbers(f.statement)}</p>
      <p className="rp-foot">{f.facts?.length ?? 0} number(s) tied to result cells.</p>
      {(f.limitations?.length ?? 0) > 0 && (
        <div className="rp-sub">
          <h4>Limitations</h4>
          <ul>
            {f.limitations!.map((l, i) => (
              <li key={i}>{tidyNumbers(l)}</li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div className="rp-sub">
          <h4>Skeptic notes</h4>
          <ul>
            {notes.map((l, i) => (
              <li key={i}>{tidyNumbers(l)}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function RunSection({ r, i, doc, seen }: { r: ReportRun; i: number; doc: ReportDoc; seen: Map<string, number> }) {
  const panels = panelsOfRun(r, doc.panels);
  const own = panels.filter((p) => seen.get(p.hash) === i);
  const refs = panels.filter((p) => seen.get(p.hash) !== i);
  const it = r.interpretation;
  return (
    <section className="rp-sec rp-newpage rp-run" data-run={r.id}>
      <header className="rp-sec-h">
        <span className="rp-sec-n">{`Q${i + 1}`}</span>
        <h2>{r.question ?? 'Investigation'}</h2>
      </header>
      <p className="rp-meta rp-meta-row">
        <span>run <b className="mono">{r.id.slice(0, 8)}</b></span>
        <span>state <b>{label(r.state.toLowerCase())}</b></span>
        {r.source && <span>source <b>{r.source}</b></span>}
        <span>started <b>{formatUtc(r.createdAt)}</b></span>
        <span>findings <b>{it.findings.length}</b></span>
      </p>
      {it.findings.length === 0 && <p className="rp-empty">{it.state === 'ready' ? 'The interpretation produced no findings.' : `No interpretation is available (${it.state}${it.reason ? `: ${it.reason}` : ''}).`}</p>}
      {it.findings.length > 0 && <h3 className="rp-h3">Findings</h3>}
      {it.findings.map((f) => (
        <FindingCard key={f.id} f={f} />
      ))}
      {own.length > 0 && <h3 className="rp-h3">Charts and tables</h3>}
      {own.map((p) => (
        <PanelCard key={p.hash} p={p} />
      ))}
      {refs.length > 0 && (
        <p className="rp-foot">
          Also cited here, drawn under an earlier question: {refs.map((p) => `${panelTitle(p)} (Q${(seen.get(p.hash) ?? 0) + 1})`).join('; ')}.
        </p>
      )}
    </section>
  );
}

function ProofBox({ p }: { p: ReportProof }) {
  const v = p.verification;
  return (
    <div className="rp-proof">
      <div className="rp-tags">
        <Tag tone={p.state}>OutLayer proof: {label(p.state)}</Tag>
        {v.decision && <Tag tone={v.decision === 'accept' ? 'ok' : 'bad'}>decision: {v.decision}</Tag>}
        <span className="rp-foot">{formatUtc(p.createdAt)}</span>
      </div>
      <dl className="rp-dl">
        <dt>OutLayer request id</dt>
        <dd className="mono">{p.job.requestId ?? dash}</dd>
        <dt>Transaction</dt>
        <dd className="mono">
          {p.job.txHash ? (
            <a href={nearblocksTx(p.job.txHash)} target="_blank" rel="noreferrer">
              {nearblocksTx(p.job.txHash)}
            </a>
          ) : (
            dash
          )}
        </dd>
        <dt>WASM sha256</dt>
        <dd className="mono wrap">{p.wasmSha256}</dd>
        <dt>Input sha256</dt>
        <dd className="mono wrap">{p.inputSha256}</dd>
        <dt>Output sha256</dt>
        <dd className="mono wrap">{p.outputSha256 ?? dash}</dd>
        <dt>MRTD</dt>
        <dd className="mono wrap">{v.mrTd ?? dash}</dd>
        <dt>RTMR3</dt>
        <dd className="mono wrap">{v.rtmr3 ?? dash}</dd>
        {v.reasons.length > 0 && (
          <>
            <dt>Reasons</dt>
            <dd>{v.reasons.join('; ')}</dd>
          </>
        )}
        <dt>Cost</dt>
        <dd className="mono">
          {p.cost.totalYocto ? `${formatNear(p.cost.totalYocto)} NEAR total` : dash}
          {p.cost.chargedYocto ? ` (credits ${formatNear(p.cost.chargedYocto)}, gas ${formatNear(p.cost.gasYocto)})` : ''}
        </dd>
      </dl>
      {p.error && <p className="rp-empty">Error: {p.error}</p>}
    </div>
  );
}

function CapsuleBox({ c }: { c: ReportCapsule }) {
  const h = c.hashes ?? {};
  const hashRows: [string, string | null | undefined][] = [
    ['Capsule id', c.capsuleId],
    ['Preregistration hash', h.preregistrationHash],
    ['Source snapshot hash', h.sourceSnapshotHash],
    ['Semantic model hash', h.semanticModelHash],
    ['Result manifest hash', h.resultManifestHash],
    ['Analysis code commit', h.analysisCodeCommit],
  ];
  const ver = c.verification;
  return (
    <article className="rp-card rp-capsule">
      <header>
        <h3>{c.title ?? c.capsuleId}</h3>
        <div className="rp-tags">
          {c.label && <Tag tone="info">{c.label}</Tag>}
          {ver?.local && <Tag tone={ver.local.status}>local: {label(ver.local.status)}</Tag>}
          {ver?.outlayer && <Tag tone={ver.outlayer.status}>OutLayer: {label(ver.outlayer.status)}</Tag>}
        </div>
      </header>
      <div className="rp-vbox">
        <h4>Verification</h4>
        <dl className="rp-dl">
          {hashRows.map(([k, v]) => (
            <div key={k} className="rp-dl-row">
              <dt>{k}</dt>
              <dd className="mono wrap">{v ?? dash}</dd>
            </div>
          ))}
        </dl>
        {c.proofs.length === 0 ? <p className="rp-empty">No OutLayer proof has been run for this capsule.</p> : c.proofs.map((p) => <ProofBox key={p.proofId} p={p} />)}
        <p className="rp-note">Intel collateral (TCB status) not checked.</p>
      </div>
      {(c.results?.length ?? 0) > 0 && (
        <>
          <h4>Measurements</h4>
          <Table columns={[{ name: 'Measurement' }, { name: 'Value' }, { name: 'Unit' }]} rows={c.results!.slice(0, TABLE_ROW_CAP).map((r) => [r.label, r.value, r.unit])} more={Math.max(0, c.results!.length - TABLE_ROW_CAP)} mono={false} />
        </>
      )}
      {(c.limitations?.length ?? 0) > 0 && (
        <div className="rp-sub">
          <h4>Capsule limitations</h4>
          <ul>
            {c.limitations!.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function CostRow({ e }: { e: CostEntry }) {
  const amount = e.unit === 'usd' ? `USD ${e.amount}` : `${formatNear(e.amount, { round: 'up' })} NEAR`;
  return (
    <tr>
      <td>{e.at ? formatUtc(e.at, false) : dash}</td>
      <td>{e.label}</td>
      <td>{e.source === 'credits' ? 'NEAR credits' : 'model'}</td>
      <td className="num mono">{amount}</td>
      <td className="mono">
        {e.txHash ? (
          <a href={nearblocksTx(e.txHash)} target="_blank" rel="noreferrer">
            {shortHash(e.txHash, 8, 6)}
          </a>
        ) : (
          dash
        )}
      </td>
    </tr>
  );
}

function Stat({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rp-stat">
      <span className="rp-stat-k">{k}</span>
      <span className="rp-stat-v">{v}</span>
      {sub && <span className="rp-stat-s">{sub}</span>}
    </div>
  );
}

/** Wait until fonts and every chart are settled, then flag the document for the PDF renderer. */
function useReady(): [React.RefObject<HTMLDivElement | null>, boolean] {
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

function Toolbar({ wid }: { wid: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/report/${wid}/pdf`, { cache: 'no-store' });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { message?: string } | null;
        throw new Error(j?.message ?? `The PDF could not be made (HTTP ${r.status}).`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? pdfFilename(wid);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The PDF could not be made.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rp-toolbar" role="toolbar" aria-label="Report actions">
      <Link href={`/w/${wid}/overview`} className="rp-tb-back">
        ← Workspace
      </Link>
      <span className="rp-tb-sp" />
      {err && <span className="rp-tb-err" role="alert">{err}</span>}
      <button type="button" className="rp-btn" onClick={() => window.print()}>
        Print
      </button>
      <button type="button" className="rp-btn primary" onClick={download} disabled={busy} data-testid="report-download">
        {busy ? 'Preparing PDF…' : 'Download PDF'}
      </button>
    </div>
  );
}

export default function ReportView({ doc }: { doc: ReportDoc }) {
  const [root, ready] = useReady();
  const w = doc.workspace;
  const summary = executiveSummary(doc.runs);
  // Each panel is drawn once, under the first question that cites it.
  const seen = new Map<string, number>();
  doc.runs.forEach((r, i) => r.panelHashes.forEach((h) => !seen.has(h) && seen.set(h, i)));
  const findings = doc.runs.reduce((n, r) => n + r.interpretation.findings.length, 0);
  const proofs = doc.capsules.reduce((n, c) => n + c.proofs.length, 0);
  const generated = formatUtc(doc.generatedAt);
  const title = w.objective.length > 70 ? `${w.objective.slice(0, 69)}…` : w.objective;
  return (
    <div className="rp" ref={root} data-report-ready={ready ? 'true' : 'false'} data-report-title={title} data-report-generated={doc.generatedAt}>
      <Toolbar wid={w.id} />
      <div className="rp-paper">
        <div className="rp-doc">
          {/* ---- cover ---- */}
          <section className="rp-cover">
            <div className="rp-cover-top">
              <Wordmark tone="black" size={26} />
              <span className="rp-cover-kind">Workspace report</span>
            </div>
            <div className="rp-cover-mid">
              <p className="rp-eyebrow">Research objective</p>
              <h1>{w.objective}</h1>
              <div className="rp-rule" />
            </div>
            <dl className="rp-cover-meta">
              <div><dt>Generated</dt><dd>{generated}</dd></div>
              <div><dt>Owner</dt><dd>{w.owner?.displayName ?? dash}{w.owner?.nearAccountId ? <span className="rp-sub-d mono"> {w.owner.nearAccountId}</span> : null}</dd></div>
              <div><dt>Data window</dt><dd>{w.dataWindow ? `${day(w.dataWindow.from)} to ${day(w.dataWindow.to)}` : dash}</dd></div>
              <div><dt>Network scope</dt><dd>{w.networkScope}</dd></div>
              <div><dt>Workspace created</dt><dd>{day(w.createdAt)}</dd></div>
              <div><dt>Workspace id</dt><dd className="mono">{w.id}</dd></div>
            </dl>
            <p className="rp-cover-foot">Every number in this report comes from a stored result cell. Unknown values are shown as {dash}, never as zero.</p>
          </section>

          {/* ---- executive summary ---- */}
          <Section n="01" title="Executive summary">
            <div className="rp-stats">
              <Stat k="Questions" v={doc.runs.length} />
              <Stat k="Findings" v={findings} />
              <Stat k="Charts and tables" v={doc.panels.length} />
              <Stat k="Monitors" v={doc.monitors.length} />
              <Stat k="OutLayer proofs" v={proofs} />
              <Stat k="Model cost" v={doc.costs.modelUsd ? `USD ${doc.costs.modelUsd}` : dash} />
            </div>
            {!hasContent(doc) && <p className="rp-empty">This workspace has no investigations, hypotheses, markers, monitors or capsules yet.</p>}
            {summary.length > 0 && (
              <>
                <p className="rp-lead">What the data showed, in the findings&apos; own words. Each statement passed the numeric grounding check against its result cells.</p>
                <ol className="rp-summary">
                  {summary.map((s) => (
                    <li key={s.finding.id}>
                      <span className="rp-summary-q">{s.question ?? 'Investigation'}</span>
                      <span className="rp-summary-s">{tidyNumbers(s.finding.statement)}</span>
                      <span className="rp-tags"><Tag tone={s.finding.status}>{label(s.finding.status)}</Tag></span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {doc.runs.length > 0 && summary.length === 0 && <p className="rp-empty">No grounded finding exists yet, so there is no summary to quote.</p>}
          </Section>

          {/* ---- one section per question ---- */}
          {doc.runs.map((r, i) => (
            <RunSection key={r.id} r={r} i={i} doc={doc} seen={seen} />
          ))}

          {/* ---- hypotheses ---- */}
          <Section n="02" title="Hypotheses">
            {doc.hypotheses.length === 0 && <p className="rp-empty">No hypotheses.</p>}
            {doc.hypotheses.map((h) => (
              <article key={h.hypothesisId} className="rp-card">
                <div className="rp-tags">
                  <Tag tone={h.status === 'frozen' ? 'info' : 'neutral'}>{label(h.status)}</Tag>
                  {h.registered && <Tag tone="ok">registered</Tag>}
                  {h.verdict && <Tag tone="info">verdict: {label(h.verdict)}</Tag>}
                  <span className="rp-foot">v{h.version ?? 1}</span>
                </div>
                <p className="rp-statement">{tidyNumbers(h.proposition)}</p>
                <dl className="rp-dl">
                  {h.target && (<><dt>Target</dt><dd>{h.target}</dd></>)}
                  {h.predictor && (<><dt>Predictor</dt><dd>{h.predictor}</dd></>)}
                  {h.benchmark && (<><dt>Benchmark</dt><dd>{h.benchmark}</dd></>)}
                  {h.falsification && (<><dt>Falsified if</dt><dd>{h.falsification}</dd></>)}
                  {h.registrationHash && (<><dt>Registration hash</dt><dd className="mono wrap">{h.registrationHash}</dd></>)}
                </dl>
              </article>
            ))}
          </Section>

          {/* ---- monitors ---- */}
          <Section n="03" title="Monitors" newPage={false}>
            {doc.monitors.length === 0 && <p className="rp-empty">No monitors.</p>}
            {doc.monitors.map((m) => {
              const c = m.condition;
              const rule = c.kind === 'compare' ? `${c.metricId ?? 'metric'} ${c.op === 'lt' ? '<' : c.op === 'gt' ? '>' : c.op === 'lte' ? '≤' : c.op === 'gte' ? '≥' : (c.op ?? '?')} ${c.value ?? dash}` : JSON.stringify(c);
              const ev = m.lastEvaluation;
              const values = ev?.evaluatedValue?.values;
              const cur = c.metricId && values ? values[c.metricId] : undefined;
              return (
                <article key={m.ruleId} className="rp-card rp-monitor">
                  <div className="rp-tags">
                    <Tag tone={m.enabled ? 'ok' : 'neutral'}>{m.enabled ? 'enabled' : 'disabled'}</Tag>
                    <span className="rp-foot">source {m.sourceId}</span>
                  </div>
                  <p className="rp-statement">{m.name}</p>
                  <dl className="rp-dl">
                    <dt>Rule</dt>
                    <dd className="mono">{rule}</dd>
                    <dt>Threshold</dt>
                    <dd className="mono">{c.value ?? dash}</dd>
                    <dt>Last evaluation</dt>
                    <dd>{ev ? `${formatUtc(ev.evaluatedAt)}, ${label(ev.status)}${cur !== undefined && cur !== null ? `, value ${cur.toLocaleString('en-US')}` : ''}` : 'never evaluated'}</dd>
                    <dt>Triggers</dt>
                    <dd>{m.triggerCount === 0 ? 'none fired' : `${m.triggerCount} fired${m.triggerCount > m.triggers.length ? ` (latest ${m.triggers.length} listed)` : ''}`}</dd>
                  </dl>
                  {m.triggers.length > 0 && (
                    <ul className="rp-mini">
                      {m.triggers.map((t, i) => (
                        <li key={t.triggerId ?? i} className="mono">{formatUtc(t.firedAt ?? t.createdAt ?? null)} {t.mode ? `(${t.mode})` : ''}</li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </Section>

          {/* ---- markers ---- */}
          <Section n="04" title="Markers" newPage={false}>
            {doc.markers.length === 0 && <p className="rp-empty">No markers.</p>}
            {doc.markers.length > 0 && (
              <Table
                columns={[{ name: 'Anchor' }, { name: 'Status' }, { name: 'Question' }, { name: 'Created' }]}
                rows={doc.markers.slice(0, 40).map((m) => [
                  m.anchorType === 'time_point' && typeof m.anchor.at === 'string' ? `time point ${day(m.anchor.at)}` : label(m.anchorType),
                  label(m.status.toLowerCase()),
                  m.question ? tidyNumbers(m.question) : null,
                  day(m.timestamp),
                ])}
                more={Math.max(0, doc.markers.length - 40)}
                mono={false}
              />
            )}
          </Section>

          {/* ---- verification and publication ---- */}
          <Section n="05" title="Verification and publication">
            {doc.capsules.length === 0 && <p className="rp-empty">No capsule has been built for this workspace.</p>}
            {doc.capsules.map((c) => (
              <div key={c.capsuleId}>
                <CapsuleBox c={c} />
                <article className="rp-card rp-pub">
                  <h4>Publication status</h4>
                  <dl className="rp-dl">
                    <dt>State</dt>
                    <dd><Tag tone={c.publication.public ? 'ok' : 'neutral'}>{label(c.publication.state)}{c.publication.public ? ' (public)' : ' (not public)'}</Tag></dd>
                    <dt>Badge</dt>
                    <dd>{c.publication.badge ?? dash}</dd>
                    <dt>Published</dt>
                    <dd>{c.publication.publishedAt ? formatUtc(c.publication.publishedAt) : dash}</dd>
                    {c.publication.acknowledged.length > 0 && (<><dt>Acknowledged</dt><dd>{c.publication.acknowledged.join(', ')}</dd></>)}
                  </dl>
                </article>
              </div>
            ))}
          </Section>

          {/* ---- cost ---- */}
          <Section n="06" title="Cost">
            <div className="rp-stats two">
              <Stat k="Model spend" v={doc.costs.modelUsd ? `USD ${doc.costs.modelUsd}` : dash} sub="recorded by the included runs" />
              <Stat k="NEAR credits charged" v={`${formatNear(doc.costs.creditsChargedYocto, { round: 'up' })} NEAR`} sub={<span className="mono">{doc.costs.creditsChargedYocto} yoctoNEAR</span>} />
            </div>
            {doc.costs.entries.length === 0 ? (
              <p className="rp-empty">No cost entries were recorded for this workspace.</p>
            ) : (
              <div className="rp-tablewrap">
                <table className="rp-table">
                  <thead>
                    <tr><th>Date</th><th>Entry</th><th>Paid with</th><th className="num">Amount</th><th>Transaction</th></tr>
                  </thead>
                  <tbody>
                    {doc.costs.entries.slice(0, 80).map((e, i) => (
                      <CostRow key={i} e={e} />
                    ))}
                  </tbody>
                </table>
                {doc.costs.entries.length > 80 && <p className="rp-more">{moreRows(doc.costs.entries.length - 80)}</p>}
              </div>
            )}
            <p className="rp-note">{doc.costs.basis}</p>
          </Section>

          {/* ---- limitations ---- */}
          <Section n="07" title="Limitations" newPage={false}>
            {doc.limitations.length === 0 ? (
              <p className="rp-empty">No report-level limitation was recorded. Each finding and chart lists its own limits above.</p>
            ) : (
              <ul className="rp-limits">
                {doc.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
