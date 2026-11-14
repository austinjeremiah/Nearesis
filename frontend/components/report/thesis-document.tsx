'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Wordmark from '@/components/Wordmark';
import { ReportChart } from '@/components/report/report-chart';
import { Section, Stat, Tag, useReady } from '@/components/report/parts';
import { formatUtc } from '@/lib/format';
import { tidyNumberNodes } from '@/lib/prose';
import { parseMarkdown } from '@/lib/thesis-track/markdown';
import { OUTCOME_TONE, OUTCOME_WORD, UNAVAILABLE_TEXT, droppedText } from '@/lib/thesis/challenge';
import {
  COVER_NOTE,
  SECTION_TITLE,
  chartView,
  challengeView,
  changeMind,
  citeParts,
  coverFields,
  coverLabel,
  documentTiles,
  evidenceSections,
  firstEvidence,
  lockLine,
  nearblocksTx,
  parseEvidence,
  planView,
  publicFlowHref,
  receiptsLine,
  roundingLines,
  sectionNumber,
  sectionPlan,
  shortClaim,
  sourceGroups,
  strengthRows,
  thesisFlowHref,
  thesisPdfFilename,
  verdictHeadline,
  whyVerdict,
  type ChartView,
  type DocMeta,
  type EvCard,
  type Evidence,
  type SecId,
} from '@/lib/thesis/document';
import { statusLabel, statusTone, type Thesis, type ThesisSection } from '@/lib/thesis-track/model';

const dash = '—';
const unknown = 'unknown';
const TONE: Record<string, string> = { ok: 'ok', bad: 'bad', warn: 'warn', info: 'info', '': 'neutral' };
const chipTone = (s: string): string => {
  const v = s.toLowerCase();
  return v === 'supported' ? 'ok' : v === 'mixed' ? 'warn' : /not_supported|not supported|unsupported|failed|invalid/.test(v) ? 'bad' : v === 'cannot_compute' ? 'bad' : v === 'insufficient_data' || v === 'insufficient data' ? 'neutral' : TONE[v] ?? 'info';
};

/* ------------------------------------------------------------------ small parts */

/** A sentence with its citation numbers as superscripts and its numbers made readable (the exact value is the tooltip). */
function Prose({ text, refs }: { text: string; refs: boolean }) {
  const parts = citeParts(text, refs);
  return (
    <>
      {parts.map((p, i) => (typeof p === 'number' ? <sup key={i} className="rp-cite">{p}</sup> : <span key={i}>{tidyNumberNodes(p)}</span>))}
    </>
  );
}

function MdTable({ raw }: { raw: string }) {
  const t = parseMarkdown(raw).find((b) => b.t === 'table');
  if (!t || t.t !== 'table') return null;
  const text = (c: { t: string; v?: string; c?: unknown[] }[]): string => c.map((n) => (n.t === 'text' || n.t === 'code' ? (n.v ?? '') : text((n.c ?? []) as never))).join('');
  return (
    <div className="rp-tablewrap">
      <table className="rp-table">
        <thead>
          <tr>
            {t.head.map((c, i) => (
              <th key={i}>{text(c as never)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} className={ci > 0 ? 'mono' : ''}>{text(c as never)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Query({ id, label, sql }: { id: string; label: string; sql: string | null }) {
  return (
    <>
      <div className="rp-q-l">{label}</div>
      {sql ? (
        <pre className="rp-q-sql" id={id}>
          <code>{sql}</code>
        </pre>
      ) : (
        <p className="rp-foot">{unknown} (not included in this document)</p>
      )}
    </>
  );
}

/** The query behind a chart: collapsed on screen behind "Show query", always printed in full. */
function QueryBlock({ c }: { c: ChartView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rp-q${open ? ' open' : ''}`} data-testid="thesis-doc-query">
      <button type="button" className="rp-q-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide query' : 'Show query'}
      </button>
      <div className="rp-q-body">
        <p className="rp-meta">
          <span>result hash <b className="wrap">{c.resultHash ?? unknown}</b></span>
          <span><Tag tone={c.tag.executed ? 'ok' : 'warn'}>{c.tag.text}</Tag></span>
        </p>
        <Query id={`q-${c.id}`} label="Executed SQL (the local query that produced the data)" sql={c.sql} />
        {c.sqlBigQuery && <Query id={`qb-${c.id}`} label="BigQuery SQL" sql={c.sqlBigQuery} />}
      </div>
    </div>
  );
}

function ChartCard({ c }: { c: ChartView }) {
  const label = `${c.title}. ${c.type === 'bar' ? 'Bar' : 'Line'} chart, ${c.x.length} points.`;
  return (
    <figure className="rp-card rp-panel" data-panel={c.id} data-testid="thesis-doc-chart">
      <figcaption>
        <span className="rp-panel-t">{c.title}</span>
        <span className="rp-panel-k">{c.type === 'bar' ? 'bar' : 'line'}</span>
      </figcaption>
      <p className="rp-meta">
        {c.meta.map((m) => (
          <span key={m.k}>{m.k} <b>{m.v}</b></span>
        ))}
      </p>
      {c.points > 0 ? (
        <>
          <ReportChart type={c.type} x={c.x} series={c.series} unit={c.unit} ariaLabel={label} height={c.type === 'bar' ? 210 : 180} />
          <p className="rp-foot">
            {c.points.toLocaleString('en-US')} points drawn{c.hidden > 0 ? `; ${c.hidden} other column${c.hidden === 1 ? '' : 's'} of the panel stay in the data` : ''}; a missing value is a gap, never zero.
          </p>
        </>
      ) : (
        <p className="rp-empty">No data points in this document.</p>
      )}
      {c.sentence && <p className="rp-statement">{tidyNumberNodes(c.sentence)}</p>}
      {c.against && (
        <p className="rp-note">
          <b>Evidence against.</b> {tidyNumberNodes(c.against)}
        </p>
      )}
      {c.caveats.length > 0 && (
        <ul className="rp-caveats">
          {c.caveats.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      )}
      <QueryBlock c={c} />
    </figure>
  );
}

function EvidenceCard({ c, refs }: { c: EvCard; refs: boolean }) {
  return (
    <article className="rp-card rp-finding rp-card-tight" data-testid="thesis-doc-finding" data-contradicting={c.contradicting ? 'true' : undefined}>
      {(c.contradicting || c.chips.length > 0) && (
        <div className="rp-tags">
          {c.contradicting && <Tag tone="bad">cuts against the verdict</Tag>}
          {c.chips.map((x, i) => (
            <Tag key={i} tone={chipTone(x.tone)}>{x.text.replace(/_/g, ' ')}</Tag>
          ))}
        </div>
      )}
      <p className="rp-statement"><Prose text={c.text} refs={refs} /></p>
      {c.cited.length > 0 && (
        <div className="rp-sub">
          <h4>Cited values</h4>
          <ul>
            {c.cited.map((v, i) => (
              <li key={i} className="mono"><Prose text={v} refs={refs} /></li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function EvidenceBody({ ev, kind, sec }: { ev: Evidence; kind: 'for' | 'against'; sec: ThesisSection | null }) {
  const refs = (sec?.references?.length ?? 0) > 0;
  if (!sec) return <p className="rp-empty">This section is not in the document ({unknown}).</p>;
  const empty = ev.cards.length === 0 && ev.groups.length === 0 && ev.tables.length === 0 && ev.notes.length === 0 && ev.intro.length === 0;
  return (
    <div data-testid={`thesis-doc-evidence-${kind}`}>
      {empty && <p className="rp-empty">The section lists no {kind === 'for' ? 'evidence for' : 'evidence against'} the claim.</p>}
      {ev.intro.map((t, i) => (
        <p key={i} className="rp-note"><Prose text={t} refs={refs} /></p>
      ))}
      {ev.cards.map((c, i) => (
        <EvidenceCard key={i} c={c} refs={refs} />
      ))}
      {ev.tables.map((t, i) => (
        <MdTable key={i} raw={t} />
      ))}
      {ev.groups.length > 0 && <h3 className="rp-h3">Skeptic notes</h3>}
      {ev.groups.map((g) => (
        <div key={g.label} className="rp-sub" data-testid="thesis-doc-notes">
          <h4>{g.label}</h4>
          <ul>
            {g.notes.map((n, i) => (
              <li key={i}><Prose text={n} refs={refs} /></li>
            ))}
          </ul>
          {g.more.map((m, i) => (
            <p key={i} className="rp-more"><Prose text={m} refs={refs} /></p>
          ))}
        </div>
      ))}
      {ev.notes.map((t, i) => (
        <p key={i} className="rp-note"><Prose text={t} refs={refs} /></p>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ toolbar */

function Toolbar({ meta, mode, slug }: { meta: DocMeta; mode: 'app' | 'public'; slug: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/thesis/${encodeURIComponent(meta.id)}/pdf`, { cache: 'no-store' });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { message?: string } | null;
        throw new Error(j?.message ?? `The PDF could not be made (HTTP ${r.status}).`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? thesisPdfFilename(meta.id);
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
  const pub = mode === 'public' && slug;
  return (
    <div className="rp-toolbar" role="toolbar" aria-label="Thesis document actions">
      {pub ? (
        <Link href={publicFlowHref(slug)} className="rp-tb-back">← Shared thesis</Link>
      ) : (
        <button type="button" className="rp-btn rp-btn-quiet" onClick={() => (window.history.length > 1 ? router.back() : router.push('/thesis'))} data-testid="thesis-doc-back">
          ← Back
        </button>
      )}
      <span className="rp-tb-sp" />
      {err && <span className="rp-tb-err" role="alert">{err}</span>}
      <Link href={pub ? publicFlowHref(slug) : thesisFlowHref(meta.id)} className="rp-btn" data-testid="thesis-doc-interactive">
        Interactive view
      </Link>
      <button type="button" className="rp-btn" onClick={() => window.print()} data-testid="thesis-doc-print">
        {pub ? 'Print or save as PDF' : 'Print'}
      </button>
      {!pub && (
        <button type="button" className="rp-btn primary" onClick={download} disabled={busy} data-testid="thesis-doc-download">
          {busy ? 'Preparing PDF…' : 'Download PDF'}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the document */

export default function ThesisDocument({ doc: t, meta, mode = 'app', slug = null }: { doc: Thesis; meta: DocMeta; mode?: 'app' | 'public'; slug?: string | null }) {
  const [root, ready] = useReady();
  const plan = sectionPlan(t, meta);
  const num = (id: SecId) => sectionNumber(plan, id);
  const has = (id: SecId) => plan.includes(id);
  const status = t.verdict?.status;
  const tone = statusTone(status);
  const tiles = documentTiles(t, meta.strength);
  const headline = verdictHeadline(t);
  const why = whyVerdict(t);
  const { forSec, againstSec } = evidenceSections(t);
  const evFor = parseEvidence(forSec?.markdown, 'for');
  const evAgainst = parseEvidence(againstSec?.markdown, 'against');
  const pv = planView(t);
  const lock = lockLine(t);
  const charts = (t.charts ?? []).map((c) => chartView(c));
  const mind = changeMind(t);
  const claims = t.claims ?? [];
  const hashes = t.reproduce?.hashes ?? [];
  const v = t.verification;
  const out = v?.outlayer;
  const at = t.test?.attestation;
  const unable = t.unableToCompute ?? [];
  const rel = t.test?.relatedness;
  const rounding = roundingLines(t);
  const strength = strengthRows(meta.strength);
  const receipts = receiptsLine(meta.receipts);
  const sources = sourceGroups(t);
  const title = shortClaim(t.hypothesis);
  return (
    <div className="rp rp-thesis" ref={root} data-report-ready={ready ? 'true' : 'false'} data-report-title={title} data-report-generated={t.generatedAt ?? ''} data-thesis-ready={ready ? 'true' : 'false'} data-thesis-title={title} data-thesis-generated={t.generatedAt ?? ''} data-testid="thesis-document">
      <Toolbar meta={meta} mode={mode} slug={slug} />
      <div className="rp-paper">
        <div className="rp-doc">
          {/* ---- cover ---- */}
          <section className="rp-cover">
            <div className="rp-cover-top">
              <Wordmark tone="black" size={26} />
              <span className="rp-cover-kind">{coverLabel(meta)}</span>
            </div>
            <div className="rp-cover-mid">
              <p className="rp-eyebrow">{t.title ? 'Thesis' : 'Claim under test'}</p>
              <h1>{t.title ?? t.hypothesis ?? unknown}</h1>
              {t.title && t.hypothesis && <p className="rp-cover-claim">{t.hypothesis}</p>}
              <div className="rp-rule" />
              <div className="rp-tags rp-cover-chip">
                <Tag tone={chipTone(status ?? '')}>{statusLabel(status)}</Tag>
                {meta.published && <Tag tone="ok">published</Tag>}
              </div>
            </div>
            <div>
              <dl className="rp-cover-meta">
                {coverFields(t, meta).map((f) => (
                  <div key={f.key}>
                    <dt>{f.label}</dt>
                    <dd className={f.mono ? 'mono wrap' : undefined}>{f.value}</dd>
                  </div>
                ))}
              </dl>
              {lock && (
                <p className="rp-cover-lock" data-testid="thesis-doc-lock">
                  {lock.text}.{lock.fingerprint && <> Fingerprint <span className="mono">{lock.fingerprint}</span>.</>}
                </p>
              )}
              <p className="rp-cover-foot">{COVER_NOTE}</p>
            </div>
          </section>

          {/* ---- summary ---- */}
          <Section n={num('summary')} title={SECTION_TITLE.summary}>
            <div className="rp-stats" style={{ gridTemplateColumns: `repeat(${Math.max(tiles.length, 1)}, 1fr)` }} data-testid="thesis-doc-tiles">
              {tiles.map((x) => (
                <Stat key={x.key} k={x.label} v={x.value} sub={x.sub} exact={x.exact && x.exact !== x.value ? x.exact : undefined} className={x.key === 'window' ? 'rp-stat-win' : x.small ? 'rp-stat-sm' : undefined} />
              ))}
            </div>
            <p className="rp-lead">What the test found, in the document&apos;s own words.</p>
            <p className="rp-statement rp-verdict-line" data-testid="thesis-doc-headline">
              <Tag tone={chipTone(status ?? '')}>{statusLabel(status)}</Tag> {headline ? tidyNumberNodes(headline) : unknown}
            </p>
            {why && (
              <>
                <h3 className="rp-h3">Why this verdict</h3>
                <p className="rp-statement" data-testid="thesis-doc-why">{why}</p>
              </>
            )}
            {firstEvidence(evFor).length > 0 && (
              <>
                <h3 className="rp-h3">First lines of evidence for</h3>
                <ul className="rp-limits">
                  {firstEvidence(evFor).map((s, i) => (
                    <li key={i}>{tidyNumberNodes(s)}</li>
                  ))}
                </ul>
              </>
            )}
            {firstEvidence(evAgainst).length > 0 && (
              <>
                <h3 className="rp-h3">First lines of evidence against</h3>
                <ul className="rp-limits">
                  {firstEvidence(evAgainst).map((s, i) => (
                    <li key={i}>{tidyNumberNodes(s)}</li>
                  ))}
                </ul>
              </>
            )}
            {tone === '' && !headline && <p className="rp-empty">The document states no verdict ({unknown}).</p>}
            {status === 'INVALID_TEST' && <p className="rp-empty" data-testid="thesis-doc-invalid">The two series are mechanically related, so a correlation between them says nothing about the claim. No verdict is given.</p>}
          </Section>

          {/* ---- test plan ---- */}
          {has('plan') && pv && (
            <Section n={num('plan')} title={SECTION_TITLE.plan} newPage={false}>
              <article className="rp-card" data-testid="thesis-doc-plan">
                <div className="rp-tags">
                  <Tag tone={pv.locked ? 'ok' : 'neutral'}>{pv.locked ? 'locked before the data' : 'not locked: no lock time recorded'}</Tag>
                  {pv.warnChosen && <Tag tone="warn" title="How the pair of series was chosen">{pv.warnChosen}</Tag>}
                </div>
                <p className="rp-statement">{pv.statement ?? 'The pair was chosen by rule, not named in advance.'}</p>
                <dl className="rp-dl">
                  {pv.lines.map((l) => (
                    <div key={l.label} className="rp-dl-row">
                      <dt>{l.label}</dt>
                      <dd>{l.value}</dd>
                    </div>
                  ))}
                  <div className="rp-dl-row">
                    <dt>Locked</dt>
                    <dd>{pv.lock ? <>{formatUtc(t.test!.plan!.lockedAt)}{pv.lock.fingerprint && <span className="mono"> · fingerprint {pv.lock.fingerprint}</span>}</> : 'not locked'}</dd>
                  </div>
                </dl>
              </article>
              {t.test && (
                <p className="rp-foot">
                  {t.test.rule ? `Rule ${t.test.rule}. ` : ''}A descriptive rule{t.test.interval ? `, with a ${t.test.interval.method ?? unknown} interval${t.test.interval.blockDays !== null ? ` (${t.test.interval.blockDays}-day blocks, ${t.test.interval.resamples ?? unknown} resamples)` : ''}` : ''}, not a significance test. Correlation does not show cause.
                </p>
              )}
            </Section>
          )}

          {/* ---- evidence ---- */}
          {has('for') && (
            <Section n={num('for')} title={SECTION_TITLE.for}>
              <EvidenceBody ev={evFor} kind="for" sec={forSec} />
            </Section>
          )}
          {has('against') && (
            <Section n={num('against')} title={SECTION_TITLE.against} newPage={false}>
              <EvidenceBody ev={evAgainst} kind="against" sec={againstSec} />
            </Section>
          )}

          {/* ---- charts and tables ---- */}
          <Section n={num('charts')} title={SECTION_TITLE.charts}>
            <p className="rp-lead">Every chart is drawn from the frozen data. A day with no value is a gap, not a zero. Each chart carries its query.</p>
            {charts.length === 0 && <p className="rp-empty">No charts in the document.</p>}
            {charts.map((c) => (
              <ChartCard key={c.id} c={c} />
            ))}
            {(t.tables?.length ?? 0) > 0 && (
              <>
                <h3 className="rp-h3">Tables used</h3>
                <div className="rp-tablewrap">
                  <table className="rp-table">
                    <thead>
                      <tr><th>Table</th><th>System</th><th>Purpose</th><th>Columns</th></tr>
                    </thead>
                    <tbody>
                      {t.tables!.map((r, i) => (
                        <tr key={i}>
                          <td className="mono" title={r.name}>{/^[0-9a-f]{32,}$/i.test(r.name) ? `${r.name.slice(0, 12)}…` : r.name}</td>
                          <td className="nw">{r.system ?? unknown}</td>
                          <td>{r.purpose ?? unknown}</td>
                          <td className="mono">{r.columns?.length ? r.columns.join(', ') : unknown}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {t.sampleQuery?.sql && (
              <>
                <h3 className="rp-h3">Sample query{t.sampleQuery.title ? `: ${t.sampleQuery.title}` : ''}</h3>
                <pre className="rp-q-sql"><code>{t.sampleQuery.sql}</code></pre>
              </>
            )}
          </Section>

          {/* ---- claims ---- */}
          {has('claims') && (
            <Section n={num('claims')} title={SECTION_TITLE.claims}>
              <div className="rp-tablewrap">
                <table className="rp-table" data-testid="thesis-doc-claims">
                  <thead>
                    <tr><th>Claim</th><th>Verdict</th><th>Estimate</th><th>What would falsify it</th></tr>
                  </thead>
                  <tbody>
                    {claims.map((c) => (
                      <tr key={c.id}>
                        <td>{c.statement}</td>
                        <td className="nw"><Tag tone={chipTone(c.verdict ?? '')}>{c.verdict ? c.verdict.replace(/_/g, ' ').toLowerCase() : unknown}</Tag></td>
                        <td>{c.estimate ? tidyNumberNodes(c.estimate) : unknown}</td>
                        <td>{c.falsification ?? 'none stated'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* ---- change our mind ---- */}
          {has('mind') && (
            <Section n={num('mind')} title={SECTION_TITLE.mind} newPage={false}>
              <ul className="rp-limits" data-testid="thesis-doc-mind">
                {mind.map((m, i) => (
                  <li key={i}>{tidyNumberNodes(m)}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* ---- monitors and markers ---- */}
          {has('monitors') && (
            <Section n={num('monitors')} title={SECTION_TITLE.monitors} newPage={false}>
              <p className="rp-lead">What watches these series and which events were marked on them, as recorded when the thesis was built.</p>
              {(['monitors', 'markers'] as const).map((k) => {
                const items = t[k] ?? [];
                const cap = k === 'markers' ? 10 : 20;
                return (
                  <article key={k} className="rp-card rp-monitor" data-testid={`thesis-doc-${k}`}>
                    <div className="rp-tags">
                      <Tag tone="neutral">{k}</Tag>
                      <span className="rp-foot">{items.length}</span>
                    </div>
                    {items.length === 0 ? (
                      <p className="rp-foot">None were recorded when this thesis was built.</p>
                    ) : (
                      <ul className="rp-mini">
                        {items.slice(0, cap).map((b, i) => (
                          <li key={i}>
                            {b.title}
                            {b.lines.length > 0 && <span className="mono rp-sub-d"> {b.lines.slice(0, 3).join(' · ')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {items.length > cap && <p className="rp-more">{items.length - cap} more in the thesis.</p>}
                  </article>
                );
              })}
            </Section>
          )}

          {/* ---- verification ---- */}
          <Section n={num('verification')} title={SECTION_TITLE.verification}>
            <article className="rp-card rp-capsule" data-testid="thesis-doc-verification">
              <header>
                <h3>Capsule and OutLayer proof</h3>
                <div className="rp-tags">
                  {v?.capsule?.status && <Tag tone={v.capsule.status}>capsule: {v.capsule.status.replace(/_/g, ' ')}</Tag>}
                  {out?.status ? <Tag tone={out.status}>OutLayer: {out.status.replace(/_/g, ' ')}</Tag> : v ? <Tag tone="neutral">no OutLayer proof</Tag> : null}
                  <Tag tone={meta.published ? 'ok' : 'neutral'}>{meta.published ? 'published' : 'not published'}</Tag>
                </div>
              </header>
              <div className="rp-vbox">
                <h4>Verification</h4>
                {!v ? (
                  <p className="rp-empty">{meta.kind === 'reference' ? 'The reference thesis is a file bundle. Check every file against the bundle hashes with the verify command in the next section.' : 'This document records no capsule verification (unknown).'}</p>
                ) : (
                  <dl className="rp-dl">
                    <div className="rp-dl-row"><dt>Capsule status</dt><dd>{v.capsule?.status ? v.capsule.status.replace(/_/g, ' ') : unknown}{v.capsule?.checkedAt ? <span className="rp-sub-d"> · checked {formatUtc(v.capsule.checkedAt)}</span> : null}</dd></div>
                    <div className="rp-dl-row"><dt>Capsule hash</dt><dd className="mono wrap">{t.origin?.capsuleHash ?? t.origin?.capsuleId ?? unknown}</dd></div>
                    <div className="rp-dl-row"><dt>OutLayer request</dt><dd className="mono">{out?.requestId ?? dash}</dd></div>
                    <div className="rp-dl-row">
                      <dt>Transaction</dt>
                      <dd className="mono wrap">
                        {out?.txHash ? (
                          <a href={nearblocksTx(out.txHash)} target="_blank" rel="noreferrer" data-testid="thesis-doc-tx">
                            {nearblocksTx(out.txHash)}
                          </a>
                        ) : (
                          dash
                        )}
                      </dd>
                    </div>
                    {at && (at.attestedByVerifier.length > 0 || at.recomputedByApi.length > 0) && (
                      <>
                        <div className="rp-dl-row"><dt>Attested by the verifier</dt><dd>{at.attestedByVerifier.join(', ') || 'nothing listed'}</dd></div>
                        <div className="rp-dl-row"><dt>Recomputed by the API</dt><dd>{at.recomputedByApi.join(', ') || 'nothing listed'}</dd></div>
                      </>
                    )}
                  </dl>
                )}
                <p className="rp-note">Intel collateral (TCB status) not checked.</p>
              </div>
            </article>
          </Section>

          {/* ---- reproduction and receipts ---- */}
          <Section n={num('reproduction')} title={SECTION_TITLE.reproduction} newPage={false}>
            <dl className="rp-dl" data-testid="thesis-doc-reproduce">
              <div className="rp-dl-row"><dt>How it is checked</dt><dd>{t.reproduce?.check ?? unknown}</dd></div>
              {t.reproduce?.command && <div className="rp-dl-row"><dt>Command</dt><dd className="mono wrap">{t.reproduce.command}</dd></div>}
              <div className="rp-dl-row"><dt>Receipts</dt><dd data-testid="thesis-doc-receipts">{receipts ?? 'unknown (the server sent none)'}</dd></div>
            </dl>
            {strength.length > 0 && meta.strength && (
              <>
                <h3 className="rp-h3">Strength checklist: {meta.strength.score} out of 100, {meta.strength.band ?? 'unknown band'}</h3>
                <div className="rp-tablewrap">
                  <table className="rp-table" data-testid="thesis-doc-strength">
                    <thead>
                      <tr><th>Check</th><th className="num">Points</th><th>Detail</th></tr>
                    </thead>
                    <tbody>
                      {strength.map((s) => (
                        <tr key={s.label}>
                          <td>{s.label}</td>
                          <td className="num nw">{s.points}</td>
                          <td>{s.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {hashes.length > 0 && (
              <>
                <h3 className="rp-h3">Hashes ({hashes.length})</h3>
                <div className="rp-tablewrap">
                  <table className="rp-table">
                    <thead>
                      <tr><th>File</th><th>sha256</th></tr>
                    </thead>
                    <tbody>
                      {hashes.slice(0, 40).map((h) => (
                        <tr key={h.path}>
                          <td className="mono">{h.path}</td>
                          <td className="mono wrap" title={h.sha256}>{h.sha256}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {hashes.length > 40 && <p className="rp-more">{hashes.length - 40} more rows in the thesis.</p>}
                </div>
              </>
            )}
          </Section>

          {/* ---- challenges ---- */}
          {has('challenges') && (
            <Section n={num('challenges')} title={SECTION_TITLE.challenges}>
              <p className="rp-lead">A skeptic model read the thesis once and said where it is weak. A challenge never changes the thesis.</p>
              {meta.challenges.map((c0) => {
                const c = challengeView(c0);
                const dropped = droppedText(c.droppedNotes);
                return (
                  <article key={c.id} className="rp-card rp-finding" data-testid="thesis-doc-challenge">
                    <div className="rp-tags">
                      <Tag tone={OUTCOME_TONE[c.outcome] || 'neutral'}>{OUTCOME_WORD[c.outcome]}</Tag>
                      {c.createdAt && <span className="rp-foot">{formatUtc(c.createdAt)}</span>}
                      {c.by && <span className="rp-foot">by {c.by}</span>}
                    </div>
                    {c.outcome === 'unavailable' && <p className="rp-statement">{UNAVAILABLE_TEXT}</p>}
                    {c.groups.map((g) => (
                      <div key={g.label} className="rp-sub">
                        <h4>{g.label}</h4>
                        <ul>
                          {g.notes.map((n, i) => (
                            <li key={i}>
                              {n.severity === 'material' && <Tag tone="warn">material</Tag>} {tidyNumberNodes(n.text)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {dropped && <p className="rp-more">{dropped}</p>}
                    {c.answer && (
                      <p className="rp-note" data-testid="thesis-doc-answer">
                        <b>The owner&apos;s answer.</b> {c.answer.text}
                        {c.answer.at ? <span className="rp-sub-d"> ({formatUtc(c.answer.at)})</span> : null}
                      </p>
                    )}
                  </article>
                );
              })}
            </Section>
          )}

          {/* ---- limits ---- */}
          <Section n={num('limits')} title={SECTION_TITLE.limits} newPage={false}>
            <h3 className="rp-h3">Unable to compute</h3>
            {unable.length === 0 ? (
              <p className="rp-empty">The document lists nothing it was unable to compute.</p>
            ) : (
              <ul className="rp-limits" data-testid="thesis-doc-unable">
                {unable.map((u, i) => (
                  <li key={i}>
                    <b>{u.what}.</b> {u.why ?? unknown}
                  </li>
                ))}
              </ul>
            )}
            {(rounding.length > 0 || rel || t.test?.partOfWhole || t.test?.pairSelection) && <h3 className="rp-h3">Notes on the test</h3>}
            <ul className="rp-limits">
              {t.test?.pairSelection && (
                <li>
                  Pair chosen by {t.test.pairSelection.chosenBy === 'user' ? 'the person who asked' : t.test.pairSelection.chosenBy === 'planner' ? 'the planner' : t.test.pairSelection.chosenBy === 'rule' ? 'a rule' : unknown}
                  {t.test.pairSelection.namedForQuestion === true ? ', named for the question' : ''}.{t.test.pairSelection.label ? ` ${t.test.pairSelection.label}.` : ''}
                </li>
              )}
              {rel && (
                <li data-testid="thesis-doc-relatedness">
                  Mechanically related? {rel.status ? rel.status.replace(/_/g, ' ') : unknown}
                  {rel.heuristic ? ' (a heuristic check)' : ''}. {rel.reason ?? ''}
                  {rel.notes.length > 0 && ` ${rel.notes.join(' ')}`}
                </li>
              )}
              {t.test?.partOfWhole === true && <li>One series is a part of the other, so the test is not valid.</li>}
              {rounding.map((r, i) => (
                <li key={i} data-testid="thesis-doc-rounding">Rounded before scaling, {r}.</li>
              ))}
            </ul>
          </Section>

          {/* ---- sources ---- */}
          {has('sources') && (
            <Section n={num('sources')} title={SECTION_TITLE.sources} newPage={false}>
              {sources.map((g) => (
                <div key={g.title} className="rp-src-group">
                  <h3 className="rp-h3">{g.title}</h3>
                  <ol className="rp-src">
                    {g.refs.map((r, i) => (
                      <li key={i}>
                        <span className="rp-src-n">{i + 1}</span>
                        <span className="mono wrap">{r}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
