'use client';

import './thesis-track.css';
import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { SectionBar } from '@/components/nx/section';
import { Clamp, Disclose, FlowCard, FlowHero, FlowRail, FlowStage, FlowStages, StatTile, useFlowSpy, type FlowItem } from '@/components/nx/flow/flow';
import { Button, EmptyState, Notice, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { DataTable } from '@/components/nx/table';
import { SeriesChart } from '@/components/nx/data/charts';
import { ReportChart } from '@/components/report/report-chart';
import { useApiGet } from '@/components/nx/data/kit';
import { fInt, toNum } from '@/lib/data/num';
import { testRows } from '@/lib/thesis/doc';
import { isCorrelation, plainLabel, plainUnit, readableCorrelation, readableNumber, stripRefs, stripStatusPrefix } from '@/lib/thesis/display';
import { formatUtc } from '@/lib/format';
import {
  BUILD_COMMAND,
  THESIS_PATH,
  chartSeries,
  isNotBuilt,
  observedPoints,
  orUnknown,
  pickSections,
  queryTag,
  statusLabel,
  statusTone,
  stripLeadingHeading,
  type Thesis,
  type ThesisChart,
  type ThesisBrief,
  type ThesisRow,
  type ThesisSection,
} from '@/lib/thesis-track/model';
import MarkdownView from './markdown-view';
import StrengthMeter from '@/components/nx/thesis/strength-meter';
import { ChallengesBody } from '@/components/nx/thesis/challenges';
import FollowUpActions from '@/components/nx/agent/followups';
import { isFindingClaim } from '@/lib/agent/followups';
import { CHOSEN_BY_LABEL, relationText, signText } from '@/lib/agent/testplan';
import type { Strength } from '@/lib/thesis/strength';
import type { Challenge } from '@/lib/thesis/challenge';

/** One fetch of the whole bundle, shared (same query key) by the page and the Sources section. */
export function useThesis() {
  return useApiGet<Thesis>(THESIS_PATH);
}

/* ------------------------------------------------------------------ small parts */

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch {
      /* clipboard blocked: the text is still selectable in the block */
    }
  };
  return (
    <div className="tt-copy">
      <pre className="tt-code" tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <Button onClick={copy} aria-label={`Copy ${label}`}>
        {done ? <Check size={13} /> : <Copy size={13} />}
        {done ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function Sql({ label, sql }: { label: string; sql: string | null | undefined }) {
  return (
    <>
      <div className="tt-sqllabel">{label}</div>
      {sql ? (
        <pre className="tt-code" tabIndex={0} aria-label={label} style={{ marginBottom: 0 }}>
          <code>{sql}</code>
        </pre>
      ) : (
        <p className="small dim" style={{ margin: 0 }}>unknown (not included in this bundle)</p>
      )}
    </>
  );
}

/** One display value: readable text, the exact text for the tooltip. */
export const shown = (v: string | null | undefined, label: string, unit?: string | null): { text: string; exact: string | undefined } =>
  v === null || v === undefined || v === '' ? { text: 'unknown', exact: undefined } : { text: isCorrelation(label, unit) ? readableCorrelation(v) : readableNumber(v), exact: v };

function PlainCell({ label, unit }: { label: string; unit?: string | null }) {
  const p = plainLabel(label, unit);
  return (
    <>
      <span className="strong">{p.label}</span>
      {p.technical && <span className="mono tiny dim th-line">{p.technical}</span>}
    </>
  );
}

function RowsTable({ rows, caption }: { rows: ThesisRow[]; caption: string }) {
  return (
    <DataTable<ThesisRow>
      caption={caption}
      rows={rows}
      rowKey={(r) => r.label}
      columns={[
        { key: 'l', header: 'Measure', render: (r) => <PlainCell label={r.label} unit={r.unit} /> },
        { key: 'v', header: 'Value', numeric: true, render: (r) => { const v = shown(r.value, r.label, r.unit); return <span className="mono" title={v.exact !== v.text ? v.exact : undefined}>{v.text}</span>; } },
        {
          key: 'u',
          header: 'Unit',
          render: (r) => {
            const u = plainUnit(r.unit);
            return u ? (
              <>
                {u.label}
                {u.technical && <span className="mono tiny dim th-line">{u.technical}</span>}
              </>
            ) : (
              <span className="dim">{r.unit ?? 'unknown'}</span>
            );
          },
        },
        { key: 'r', header: 'Source', render: (r) => (r.ref ? <span className="tt-ref" title={r.ref}>{r.ref}</span> : <span className="dim">unknown</span>) },
      ]}
    />
  );
}

/** The rule behind a workspace thesis: its name, the numbers it computed, and the thresholds fixed before any run. */
function TestBlock({ t }: { t: NonNullable<Thesis['test']> }) {
  const rows = testRows(t);
  const thresholds = t.thresholds ?? [];
  return (
    <div className="th-test" data-testid="thesis-test">
      <p className="th-test-rule mono">
        {orUnknown(t.rule)}
        {t.x || t.y ? <span className="dim"> · {orUnknown(t.x)} against {orUnknown(t.y)}</span> : null}
      </p>
      <dl className="th-kv">
        {rows.map((r) => {
          const p = plainLabel(r.label);
          const v = r.label === 'Window' ? { text: r.value, exact: undefined } : shown(r.value, r.label);
          return (
            <div key={r.label} style={{ display: 'contents' }}>
              <dt>
                {p.label}
                {p.technical && <span className="mono tiny dim th-line">{p.technical}</span>}
              </dt>
              <dd className="mono" title={v.exact !== v.text ? v.exact : undefined}>{v.text}</dd>
            </div>
          );
        })}
      </dl>
      {thresholds.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 6 }}>The rule&apos;s thresholds</div>
          <dl className="th-kv">
            {thresholds.map((r) => (
              <div key={r.key} style={{ display: 'contents' }}>
                <dt>{r.key}</dt>
                <dd className="mono" title={r.value}>{readableNumber(r.value)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="tiny dim">A descriptive correlation rule, not a significance test. Correlation does not show cause.</p>
    </div>
  );
}

export type KeyTile = { label: string; value: string; sub: string | null; hint?: string | null; exact?: string; small?: boolean };

const win = (w: { from?: string | null; to?: string | null } | null | undefined) => (w && (w.from || w.to) ? `${w.from ?? 'unknown'} to ${w.to ?? 'unknown'}` : null);

/** Up to four headline numbers: a workspace thesis shows days compared, both correlations and the window; the reference its first comparison rows. */
export function keyTiles(t: Thesis): KeyTile[] {
  const test = t.test;
  if (test && ((test.n !== null && test.n !== undefined) || test.pearson)) {
    const out: KeyTile[] = [];
    if (test.n !== null && test.n !== undefined) out.push({ label: 'Days compared', value: String(test.n), sub: 'n, aligned days' });
    const same = plainLabel('Same-day Pearson correlation');
    out.push({ label: same.label, value: test.pearson ? readableCorrelation(test.pearson) : 'unknown', exact: test.pearson ?? undefined, sub: same.technical?.toLowerCase() ?? null });
    const lag = (test.lag ?? [])[0];
    if (lag) {
      const p = plainLabel(`Pearson correlation at a lag of ${lag.days ?? 'unknown'} days`);
      out.push({ label: p.label, value: lag.value ? readableCorrelation(lag.value) : 'unknown', exact: lag.value ?? undefined, sub: p.technical });
    }
    const w = win(test.window);
    if (w) out.push({ label: 'Window', value: w, sub: 'first to last aligned day', small: true });
    return out.slice(0, 4);
  }
  const rows = (t.verdict?.comparison ?? t.verdict?.intentsVsPrice)?.rows ?? [];
  return rows.slice(0, 4).map((r) => {
    const p = plainLabel(r.label, r.unit);
    const u = plainUnit(r.unit);
    const v = shown(r.value, r.label, r.unit);
    return { label: p.label, value: v.text, exact: v.exact, hint: u && u.technical ? u.label : null, sub: p.technical ?? u?.technical ?? r.unit ?? null };
  });
}

function VerdictStage({ t, strength }: { t: Thesis; strength?: Strength | null }) {
  const status = t.verdict?.status;
  const tone = statusTone(status);
  const cmp = t.verdict?.comparison ?? t.verdict?.intentsVsPrice ?? null;
  const cmpLabel = t.verdict?.comparison ? 'Comparison' : 'Intents vs price';
  const rows = cmp?.rows ?? [];
  const tiles = keyTiles(t);
  return (
    <div className="fl-stage-body" data-testid="thesis-verdict" data-tone={tone}>
      <FlowCard tone={tone === '' ? undefined : tone} badges={<Badge tone={tone}>{statusLabel(status)}</Badge>} title="The verdict">
        <p className="fl-lead">{orUnknown(stripStatusPrefix(t.verdict?.headline, status))}</p>
        {tiles.length > 0 && (
          <div className="fl-tiles">
            {tiles.map((x) => (
              <StatTile key={x.label} label={x.label} value={x.value} sub={x.sub} hint={x.hint} exact={x.exact} small={x.small} />
            ))}
          </div>
        )}
        {cmp?.summary && <p className="tt-compare-sum">{cmp.summary}</p>}
        {rows.length > 4 || (tiles.length > 0 && rows.length > 0 && t.test) ? (
          <Disclose label={`Show all rows (${rows.length})`} openLabel="Hide rows">
            <RowsTable rows={rows} caption={`${cmpLabel} rows`} />
          </Disclose>
        ) : rows.length > 0 ? (
          <RowsTable rows={rows} caption={`${cmpLabel} rows`} />
        ) : tiles.length === 0 ? (
          <p className="small dim">No comparison rows in the bundle (unknown).</p>
        ) : null}
        {t.test && (
          <Disclose label="How this was tested" openLabel="Hide the test">
            <TestBlock t={t.test} />
          </Disclose>
        )}
      </FlowCard>
      {t.test?.plan && <PlanCard plan={t.test.plan} />}
      {strength && (
        <div id="th-strength" className="th-strength-anchor">
          <FlowCard title="How strong is this thesis" badges={<Badge outline>checked by the server, not by a model</Badge>} testid="thesis-strength">
            <StrengthMeter strength={strength} variant="full" testId="strength-full" />
          </FlowCard>
        </div>
      )}
    </div>
  );
}

/** The claim as it went on record before the data was seen: sentence, lock time, who chose the pair, the resolved series. */
function PlanCard({ plan }: { plan: NonNullable<NonNullable<Thesis['test']>['plan']> }) {
  const chosen = plan.chosenBy ? CHOSEN_BY_LABEL[plan.chosenBy] : null;
  return (
    <FlowCard title="The test plan" badges={<Badge tone={plan.lockedAt ? 'ok' : ''} outline={!plan.lockedAt}>{plan.lockedAt ? 'locked before the data' : 'lock time unknown'}</Badge>} testid="thesis-test-plan" foot={plan.sha256 ? <span title={plan.sha256}>fingerprint {plan.sha256.slice(0, 12)}</span> : undefined}>
      <p className="fl-lead" data-testid="thesis-plan-statement">{plan.statement ?? 'The pair was chosen by rule, not named in advance.'}</p>
      <dl className="th-kv">
        <dt>Locked</dt>
        <dd className="mono">{plan.lockedAt ? formatUtc(plan.lockedAt) : 'unknown'}</dd>
        <dt>Pair chosen by</dt>
        <dd data-testid="thesis-plan-chosen">{chosen ?? 'unknown'}{plan.editedByUser && plan.chosenBy !== 'user' ? ' (edited by the owner)' : ''}</dd>
        <dt>Relation</dt>
        <dd>{plan.relation ? `${relationText(plan)}, ${signText(plan.expectedSign)}` : 'unknown'}</dd>
        {plan.resolved?.x && (<><dt>First series</dt><dd>{plan.resolved.x}</dd></>)}
        {plan.resolved?.y && (<><dt>Second series</dt><dd>{plan.resolved.y}</dd></>)}
        {plan.wouldCountAsWrong && (<><dt>Would count as wrong</dt><dd>{plan.wouldCountAsWrong}</dd></>)}
      </dl>
    </FlowCard>
  );
}

/* ------------------------------------------------------------------ evidence */

function Prominent({ kind, title, section, all, clean }: { kind: 'for' | 'against'; title: string; section: ThesisSection | null; all: boolean; clean: boolean }) {
  const md = (m: string) => (clean ? stripRefs(m) : m);
  return (
    <FlowCard title={title} tone={kind === 'for' ? 'ok' : 'bad'} testid={`thesis-evidence-${kind}`}>
      {section ? (
        <Clamp all={all} lines={13}>
          <MarkdownView markdown={md(stripLeadingHeading(section.markdown, section.title))} />
        </Clamp>
      ) : (
        <p className="small dim">This section is not in the bundle (unknown).</p>
      )}
    </FlowCard>
  );
}

function EvidenceStage({ t, print }: { t: Thesis; print: boolean }) {
  const slots = pickSections(t.sections);
  const clean = t.origin?.kind === 'workspace';
  const mind = (t.verdict?.whatWouldChangeOurMind ?? []).map((m) => (clean ? stripRefs(m) : m));
  return (
    <div className="fl-stage-body">
      <div className="fl-two">
        <Prominent kind="for" title="Evidence for" section={slots.evidenceFor} all={print} clean={clean} />
        <Prominent kind="against" title="Evidence against" section={slots.evidenceAgainst} all={print} clean={clean} />
      </div>
      <FlowCard title="What would change our mind" tone="warn" testid="thesis-change-mind">
        {mind.length > 0 ? (
          <Clamp all={print} lines={9}>
            <ul className="tt-md" style={{ margin: 0, paddingLeft: 20 }}>
              {mind.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </Clamp>
        ) : slots.changeMind ? (
          <Clamp all={print} lines={9}>
            <MarkdownView markdown={clean ? stripRefs(stripLeadingHeading(slots.changeMind.markdown, slots.changeMind.title)) : stripLeadingHeading(slots.changeMind.markdown, slots.changeMind.title)} />
          </Clamp>
        ) : (
          <p className="small dim">Not stated in this bundle (unknown).</p>
        )}
      </FlowCard>
    </div>
  );
}

/* ------------------------------------------------------------------ claims */

function ClaimsStage({ t, print, followUpWorkspaceId }: { t: Thesis; print: boolean; followUpWorkspaceId?: string | null }) {
  const claims = t.claims ?? [];
  const [filter, setFilter] = useState<string>('all');
  const verdicts = [...new Set(claims.map((c) => orUnknown(c.verdict)))];
  const shown = filter === 'all' ? claims : claims.filter((c) => orUnknown(c.verdict) === filter);
  const dash = (v: string | null | undefined) => (v ? v : <span className="dim">none stated</span>);
  if (claims.length === 0) return <EmptyState title="No claims in the bundle" />;
  return (
    <div className="fl-stage-body">
      {verdicts.length > 1 && !print && (
        <div className="fl-chips" role="group" aria-label="Filter claims by verdict">
          <button type="button" className="fl-chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All {claims.length}</button>
          {verdicts.map((v) => (
            <button key={v} type="button" className="fl-chip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
              {v} {claims.filter((c) => orUnknown(c.verdict) === v).length}
            </button>
          ))}
        </div>
      )}
      <ul className="tt-claims fl-grid" aria-label="Claims">
        {shown.map((c) => (
          <li key={c.id} className="fl-card th-claim" data-surface data-testid="thesis-claim">
            <div className="fl-card-body">
              <div className="fl-badges">
                <Badge outline>{orUnknown(c.kind)}</Badge>
                <Badge tone={statusTone(c.verdict)}>{orUnknown(c.verdict)}</Badge>
              </div>
              <p className="th-claim-stmt">{c.statement}</p>
              {!print && followUpWorkspaceId && isFindingClaim(c.kind, c.statement) && <FollowUpActions statement={c.statement} workspaceId={followUpWorkspaceId} testId="claim-followups" />}
              <dl className="th-kv">
                <dt>Estimate</dt>
                <dd className={(c.estimate ?? '').length > 40 ? '' : 'mono'}>{c.estimate ?? 'unknown'}</dd>
                <dt>Uncertainty</dt>
                <dd className={(c.uncertainty ?? '').length > 40 ? '' : 'mono'}>{c.uncertainty ?? 'unknown'}</dd>
              </dl>
              {print ? (
                <dl className="th-kv">
                  <dt>Counterexample</dt>
                  <dd>{dash(c.counterexample)}</dd>
                  <dt>Falsification</dt>
                  <dd>{dash(c.falsification)}</dd>
                </dl>
              ) : (
                <Disclose label="Counterexample and falsification" openLabel="Hide details">
                  <dl className="th-kv">
                    <dt>Counterexample</dt>
                    <dd>{dash(c.counterexample)}</dd>
                    <dt>Falsification</dt>
                    <dd>{dash(c.falsification)}</dd>
                  </dl>
                </Disclose>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ charts */

function ChartCard({ c, print = false }: { c: ThesisChart; print?: boolean }) {
  const [open, setOpen] = useState(print);
  const series = chartSeries(c);
  const n = observedPoints(c);
  const tag = queryTag(c);
  const perDataset = (c as { queries?: { sqlExecuted?: string | null }[] }).queries;
  const sqlText = c.sqlExecuted ?? ((perDataset ?? []).map((q) => q?.sqlExecuted).filter((x): x is string => !!x).join('\n\n') || null);
  const kind = c.kind === 'bar' ? 'bar' : 'line';
  const win = c.window?.from || c.window?.to ? `${c.window?.from ?? 'unknown'} to ${c.window?.to ?? 'unknown'}` : 'unknown';
  const label = `${c.title}. ${c.kind === 'bar' ? 'Bar' : 'Line'} chart${c.unit ? ` in ${c.unit}` : ''}, ${c.x?.length ?? 0} days. ${c.sentence ?? ''}`.trim();
  return (
    <article className="tt-chart" data-surface data-testid="thesis-chart" data-chart={c.id}>
      <header>
        <h3>{c.title}</h3>
        <p className="tt-sentence">{orUnknown(c.sentence)}</p>
      </header>
      <div className="tt-chart-body">
        {n > 0 ? (
          print ? (
            <ReportChart
              type={kind}
              x={c.x ?? []}
              series={series.map((sr) => ({ name: sr.name, points: sr.points.map((p) => ({ x: p.x, y: toNum(p.y) })) }))}
              unit={c.unit ?? null}
              ariaLabel={label}
            />
          ) : (
            <SeriesChart series={series} ariaLabel={label} unit={c.unit ?? undefined} kind={kind} />
          )
        ) : (
          <div className="tt-nodata" role="img" aria-label={`${c.title}: no data points`}>No data points in this bundle.</div>
        )}
      </div>
      <div className="tt-chart-foot">
        {c.evidenceAgainst && (
          <div className="tt-against" role="note">
            <b>Evidence against</b>
            {c.evidenceAgainst}
          </div>
        )}
        {c.caveats && c.caveats.length > 0 && (
          print ? (
            <ul className="tt-caveats" aria-label="Caveats">
              {c.caveats.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          ) : (
            <Disclose label={`Caveats (${c.caveats.length})`} openLabel="Hide caveats">
              <ul className="tt-caveats" aria-label="Caveats">
                {c.caveats.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </Disclose>
          )
        )}
        <div className="tt-meta">
          <span><b>Source</b> {orUnknown(c.source)}</span>
          <span><b>Window</b> {win}</span>
          <span><b>Points</b> {fInt(n)}</span>
        </div>
        {!print && (
          <div>
            <Button aria-expanded={open} aria-controls={`q-${c.id}`} onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide query' : 'Show query'}
            </Button>
          </div>
        )}
        {open && (
          <div id={`q-${c.id}`} data-testid="thesis-query">
            <div className="tt-qtag">
              <Badge tone={tag.executed ? 'ok' : 'warn'}>{tag.text}</Badge>
            </div>
            <Sql label="Executed SQL (the local query that produced the data)" sql={sqlText} />
            <Sql label="BigQuery SQL" sql={c.sqlBigQuery} />
            {c.sha256 && <div className="tt-ref" style={{ marginTop: 8 }}>data sha256 {c.sha256}</div>}
          </div>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ tables + sample query */

export function TablesAndSample({ t }: { t: Thesis }) {
  const tables = t.tables ?? [];
  const sample = t.sampleQuery;
  if (tables.length === 0 && !sample?.sql) return null;
  return (
    <div className="col gap4" data-testid="thesis-tables">
      {tables.length > 0 && (
        <DataTable
          caption="Tables used by the thesis"
          rows={tables}
          rowKey={(r) => `${r.system}:${r.name}`}
          columns={[
            { key: 'n', header: 'Table', render: (r) => (/^[0-9a-f]{32,}$/i.test(r.name) ? <span className="mono strong" title={r.name}>{r.name.slice(0, 12)}…</span> : <span className="mono strong">{r.name}</span>) },
            { key: 's', header: 'System', render: (r) => orUnknown(r.system) },
            { key: 'p', header: 'Purpose', render: (r) => orUnknown(r.purpose) },
            { key: 'c', header: 'Columns', render: (r) => (r.columns?.length ? <span className="mono small">{r.columns.join(', ')}</span> : <span className="dim">unknown</span>) },
          ]}
        />
      )}
      {sample?.sql && (
        <div className="col gap2">
          <div className="label">Sample query{sample.title ? `: ${sample.title}` : ''}</div>
          <CopyBlock text={sample.sql} label="sample query" />
        </div>
      )}
    </div>
  );
}

/** Sources page section: nothing at all while loading or when the thesis is not built. */
export function SourcesThesisTables() {
  const q = useThesis();
  if (!q.data || ((q.data.tables?.length ?? 0) === 0 && !q.data.sampleQuery?.sql)) return null;
  return (
    <section className="tt-sec" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 24 }} data-testid="sources-thesis-tables">
      <SectionBar title="Tables and sample query" />
      <p className="tt-secnote">The tables behind the NEAR thesis and one query you can run yourself. The full thesis is on the Theses page.</p>
      <TablesAndSample t={q.data} />
    </section>
  );
}

/* ------------------------------------------------------------------ brief lists + verification */

function Briefs({ title, items, testid }: { title: string; items: ThesisBrief[]; testid: string }) {
  return (
    <FlowCard title={title} badges={<Badge outline>{items.length}</Badge>} testid={testid}>
      {items.length === 0 ? (
        <p className="small dim th-brief-empty">None were recorded when this thesis was built.</p>
      ) : (
        <ul className="th-brief-list">
          {items.map((b, i) => (
            <li key={i}>
              <span className="strong">{b.title}</span>
              {b.lines.map((l, j) => (
                <span key={j} className="mono tiny dim th-line">{l}</span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </FlowCard>
  );
}

export const NEARBLOCKS_TX = (hash: string) => `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;

function Step({ name, tone, word, children }: { name: string; tone: 'ok' | 'bad' | 'warn' | ''; word: string; children?: ReactNode }) {
  return (
    <div className="fl-pipe-step">
      <span className="fl-pipe-name">{name}</span>
      <Badge tone={tone} outline={tone === ''}>{word}</Badge>
      {children}
    </div>
  );
}

const stepTone = (s: string | null | undefined): 'ok' | 'bad' | 'warn' | '' => {
  const v = (s ?? '').toLowerCase();
  if (/^(verified|ok|ready|proved|proven|finalized|passed|success)/.test(v)) return 'ok';
  if (/(fail|mismatch|invalid|error)/.test(v)) return 'bad';
  return v ? 'warn' : '';
};

function VerificationStage({ t, isReference, publication }: { t: Thesis; isReference: boolean; publication: 'published' | 'draft' | null }) {
  const v = t.verification;
  const cap = v?.capsule;
  const out = v?.outlayer;
  return (
    <div className="fl-stage-body" data-testid="thesis-verification">
      <FlowCard title="From capsule to publication" foot={<span>Intel collateral (TCB status) not checked.</span>}>
        {!v ? (
          <p className="small">
            {isReference
              ? 'The reference thesis is a file bundle. Use Verify to check every file against the bundle hashes.'
              : 'This document records no capsule verification (unknown).'}
          </p>
        ) : (
          <div className="fl-pipe">
            <Step name="Capsule" tone={stepTone(cap?.status)} word={orUnknown(cap?.status)}>
              {cap?.checkedAt && <span className="fl-pipe-detail">checked {formatUtc(cap.checkedAt)}</span>}
              {t.origin?.capsuleHash && <span className="fl-pipe-detail" title={t.origin.capsuleHash}>capsule {t.origin.capsuleHash.slice(0, 16)}…</span>}
            </Step>
            <Step name="OutLayer proof" tone={out ? stepTone(out.status) : ''} word={out ? orUnknown(out.status) : 'none requested'}>
              {out?.requestId && <span className="fl-pipe-detail">request {out.requestId}</span>}
              {out?.txHash && (
                <a className="link fl-pipe-detail" href={NEARBLOCKS_TX(out.txHash)} title={out.txHash} target="_blank" rel="noopener noreferrer" data-testid="thesis-tx-link">
                  tx {out.txHash.length > 24 ? `${out.txHash.slice(0, 10)}…${out.txHash.slice(-8)}` : out.txHash}
                </a>
              )}
            </Step>
            <Step name="Publication" tone={publication === 'published' ? 'ok' : ''} word={publication ?? 'unknown'} />
          </div>
        )}
      </FlowCard>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

function NotBuilt() {
  return (
    <div className="tt-notbuilt" data-testid="thesis-not-built">
      <h2>The thesis bundle has not been built yet</h2>
      <p className="small" style={{ margin: 0 }}>
        This page reads a generated bundle of charts, claims and SQL. Nothing is shown until it exists, so there are no placeholder figures. Build it from the repository root:
      </p>
      <CopyBlock text={BUILD_COMMAND} label="build command" />
    </div>
  );
}

export function ThesisLoading() {
  return (
    <div className="tt-skel" data-testid="thesis-loading" aria-busy="true">
      <Skeleton rows={6} />
      <Skeleton rows={8} />
    </div>
  );
}

const windowOf = (t: Thesis): string | null => {
  const w = t.test?.window ?? t.charts?.find((c) => c.window?.from || c.window?.to)?.window;
  return w && (w.from || w.to) ? `${w.from ?? 'unknown'} to ${w.to ?? 'unknown'}` : null;
};

/** Caveats the charts carry, once each, with the chart they belong to. */
function chartCaveats(t: Thesis): { chart: string; text: string }[] {
  const seen = new Set<string>();
  const out: { chart: string; text: string }[] = [];
  for (const c of t.charts ?? []) for (const x of c.caveats ?? []) if (!seen.has(x)) (seen.add(x), out.push({ chart: c.title, text: x }));
  return out;
}

/**
 * The one viewer. It takes a normalised document, so the reference thesis, a workspace thesis and a public one all render
 * here, as numbered stages under a sticky rail. `print` drops the rail and swaps interactive parts for static ones (SVG
 * charts, every query, claim detail and section open, no buttons).
 */
export function ThesisDocView({
  doc: t,
  print = false,
  isReference = false,
  actions,
  publication = null,
  receiptsLine,
  reproduceHead,
  strength = null,
  strengthInline = false,
  challenges = null,
  followUpWorkspaceId = null,
}: {
  doc: Thesis;
  print?: boolean;
  isReference?: boolean;
  /** Buttons for the header: the app adds Verify/Reproduce/Share, the public page adds Open in my account. */
  actions?: ReactNode;
  publication?: 'published' | 'draft' | null;
  receiptsLine?: string | null;
  /** The app's Reproduce controls and result, shown at the top of the Reproduce stage. */
  reproduceHead?: ReactNode;
  /** Server-computed strength; the meter is hidden when null. */
  strength?: Strength | null;
  /** Open the checklist under the header meter instead of jumping to the Verdict stage (the public page). */
  strengthInline?: boolean;
  /** The Challenges stage: shown when `show` or when there are challenges; `owner` adds the answer box. */
  challenges?: { items: Challenge[]; thesisId: string | null; owner: boolean; show: boolean; action?: ReactNode } | null;
  /** Workspace the follow-up links open the Agent on; none hides the actions. */
  followUpWorkspaceId?: string | null;
}) {
  const charts = t.charts ?? [];
  const claims = t.claims ?? [];
  const slots = pickSections(t.sections);
  const hashes = t.reproduce?.hashes ?? [];
  const unable = t.unableToCompute ?? [];
  const caveats = chartCaveats(t);
  const hasBriefs = (t.monitors?.length ?? 0) > 0 || (t.markers?.length ?? 0) > 0;
  const tone = statusTone(t.verdict?.status);
  const hasTables = (t.tables?.length ?? 0) > 0 || !!t.sampleQuery?.sql;
  const items: (FlowItem & { title: string; badge?: ReactNode; note?: ReactNode })[] = [
    { id: 'th-verdict', label: 'Verdict', title: 'Verdict', dot: tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : tone === 'info' ? 'info' : 'idle', note: t.verdict?.status ? statusLabel(t.verdict.status) : undefined },
    { id: 'th-evidence', label: 'Evidence', title: 'Evidence for and against', dot: slots.evidenceFor || slots.evidenceAgainst ? 'done' : 'idle' },
    { id: 'th-claims', label: 'Claims', title: 'Claims', dot: claims.length ? 'done' : 'idle', note: `${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}` },
    { id: 'th-charts', label: 'Charts', title: 'Charts', dot: charts.length ? 'done' : 'idle', note: `${charts.length} ${charts.length === 1 ? 'chart' : 'charts'}` },
    ...(hasBriefs ? [{ id: 'th-monitors', label: 'Monitors', title: 'Monitors and markers', dot: 'done' as const, note: `${t.monitors?.length ?? 0} monitors · ${t.markers?.length ?? 0} markers` }] : []),
    ...(challenges && (challenges.show || challenges.items.length > 0)
      ? [{ id: 'th-challenges', label: 'Challenges', title: 'Challenges', dot: (challenges.items.length === 0 ? 'idle' : challenges.items[0]!.outcome === 'holds' ? 'ok' : challenges.items[0]!.outcome === 'unavailable' ? 'idle' : challenges.items[0]!.outcome === 'weakened' ? 'warn' : 'bad') as FlowItem['dot'], note: `${challenges.items.length} ${challenges.items.length === 1 ? 'challenge' : 'challenges'}` }]
      : []),
    { id: 'th-verification', label: 'Verification', title: 'Verification', dot: t.verification ? stepTone(t.verification.capsule?.status) === 'ok' ? 'ok' : 'warn' : 'idle' },
    { id: 'th-reproduce', label: 'Reproduce', title: 'Reproduce this', dot: t.reproduce?.command ? 'done' : 'idle' },
    { id: 'th-limits', label: 'Limits', title: 'What it could not do', dot: unable.length ? 'warn' : 'done', note: `${unable.length} not computed` },
    ...(slots.rest.length ? [{ id: 'th-full', label: 'Full text', title: 'The full thesis', dot: 'idle' as const, note: `${slots.rest.length} sections` }] : []),
  ];
  const { active, go } = useFlowSpy(items.map((i) => i.id), !print);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  let n = 0;
  const stage = (id: string, children: ReactNode) => {
    const it = byId[id]!;
    n += 1;
    return (
      <FlowStage key={id} id={id} n={n} title={it.title} tone={it.dot} note={it.note}>
        {children}
      </FlowStage>
    );
  };
  const meta: ReactNode[] = [];
  if (t.version) meta.push(`version ${t.version.slice(0, 16)}`);
  if (t.generatedAt) meta.push(`built ${formatUtc(t.generatedAt)}`);
  const w = windowOf(t);
  if (w) meta.push(`window ${w}`);
  meta.push(`${charts.length} charts · ${claims.length} claims`);
  if (receiptsLine) meta.push(receiptsLine);
  return (
    <div className={`fl${print ? ' fl-print' : ''}`} data-testid="thesis-view">
      <FlowHero
        eyebrow={
          <>
            {isReference && <Badge outline>reference</Badge>}
            {t.origin?.kind === 'workspace' && <Badge outline>workspace thesis</Badge>}
          </>
        }
        title={orUnknown(t.hypothesis)}
        badge={<Badge tone={tone}>{statusLabel(t.verdict?.status)}</Badge>}
        meta={meta}
        actions={actions}
        extra={strength ? <StrengthMeter strength={strength} expandable={strengthInline} onMore={strengthInline ? undefined : () => go('th-strength')} testId="strength-hero" /> : undefined}
      />
      {!print && <FlowRail label="Thesis sections" items={items} active={active} onSelect={go} />}
      <FlowStages>
        {stage('th-verdict', <VerdictStage t={t} strength={strength} />)}
        {stage('th-evidence', <EvidenceStage t={t} print={print} />)}
        {stage('th-claims', <ClaimsStage t={t} print={print} followUpWorkspaceId={followUpWorkspaceId} />)}
        {stage(
          'th-charts',
          <div className="fl-stage-body">
            <p className="tt-secnote">Every chart is drawn straight from the frozen data. A day with no value is a gap, not a zero. Each chart carries its query.</p>
            {charts.length === 0 ? (
              <EmptyState title="No charts in the bundle" body="Nothing is drawn when the bundle holds no chart data." />
            ) : (
              <div className="fl-grid tt-charts">
                {charts.map((c) => (
                  <ChartCard key={c.id} c={c} print={print} />
                ))}
              </div>
            )}
          </div>,
        )}
        {hasBriefs &&
          stage(
            'th-monitors',
            <div className="fl-stage-body">
              <p className="tt-secnote">What watches these series and which events were marked on them, as recorded when the thesis was built.</p>
              <div className="fl-two">
                <Briefs title="Monitors" items={t.monitors ?? []} testid="thesis-monitors" />
                <Briefs title="Markers" items={t.markers ?? []} testid="thesis-markers" />
              </div>
            </div>,
          )}
        {challenges && (challenges.show || challenges.items.length > 0) && stage('th-challenges', <ChallengesBody items={challenges.items} thesisId={challenges.thesisId} owner={challenges.owner} action={challenges.action} />)}
        {stage('th-verification', <VerificationStage t={t} isReference={isReference} publication={publication} />)}
        {stage(
          'th-reproduce',
          <div className="fl-stage-body" data-testid="thesis-reproduce">
            {reproduceHead && <FlowCard title="Reproduce">{reproduceHead}</FlowCard>}
            {isReference || t.origin?.kind !== 'workspace' ? (
              <div className="fl-two">
                <FlowCard title="Rebuild every chart from the frozen data">
                  <CopyBlock text={orUnknownCmd(t.reproduce?.command)} label="build command" />
                </FlowCard>
                <FlowCard title="Check the result matches the published hashes">
                  <CopyBlock text={orUnknownCmd(t.reproduce?.check)} label="verify command" />
                </FlowCard>
              </div>
            ) : (
              <FlowCard title="How the checks work" testid="thesis-how-checked">
                <p className="small" style={{ margin: 0 }}>{orUnknown(t.reproduce?.check)}</p>
                {t.reproduce?.command && <p className="mono tiny dim th-line" style={{ margin: '6px 0 0' }}>{t.reproduce.command}</p>}
              </FlowCard>
            )}
            <FlowCard title="Hashes" badges={<Badge outline>{hashes.length}</Badge>}>
              {hashes.length > 0 ? (
                print ? (
                  <HashList hashes={hashes} />
                ) : (
                  <Disclose label={`Show ${hashes.length} hashes`} openLabel="Hide hashes">
                    <HashList hashes={hashes} />
                  </Disclose>
                )
              ) : (
                <p className="small dim">No hashes in the bundle (unknown).</p>
              )}
            </FlowCard>
            {hasTables && (
              <FlowCard title="Tables and sample query">
                <TablesAndSample t={t} />
              </FlowCard>
            )}
          </div>,
        )}
        {stage(
          'th-limits',
          <div className="fl-stage-body">
            <FlowCard title="Unable to compute" badges={<Badge tone={unable.length ? 'warn' : 'ok'} outline>{unable.length}</Badge>}>
              {unable.length === 0 ? (
                <p className="small dim">The bundle lists nothing it was unable to compute.</p>
              ) : (
                <ul className="tt-unable" data-testid="thesis-unable">
                  {unable.map((u, i) => (
                    <li key={i}>
                      <b>{u.what}</b>
                      {orUnknown(u.why)}
                    </li>
                  ))}
                </ul>
              )}
            </FlowCard>
            {caveats.length > 0 && (
              <FlowCard title="Caveats the charts carry" badges={<Badge outline>{caveats.length}</Badge>}>
                <Clamp all={print} lines={8}>
                  <ul className="tt-caveats">
                    {caveats.map((c, i) => (
                      <li key={i}>
                        {c.text} <span className="dim tiny">({c.chart})</span>
                      </li>
                    ))}
                  </ul>
                </Clamp>
              </FlowCard>
            )}
          </div>,
        )}
        {slots.rest.length > 0 &&
          stage(
            'th-full',
            <div className="fl-stage-body" data-testid="thesis-sections">
              {slots.rest.map((s) => (
                <details key={s.id} className="tt-acc th-acc" open={print} data-surface>
                  <summary>{s.title}</summary>
                  <div className="tt-acc-body">
                    <MarkdownView markdown={stripLeadingHeading(s.markdown, s.title)} />
                  </div>
                </details>
              ))}
              <Notice tone="info" title="Nothing here is invented">
                Every number comes from a frozen raw file and carries a pointer to it. Anything that could not be computed is listed under Limits with the reason.
              </Notice>
            </div>,
          )}
      </FlowStages>
    </div>
  );
}

function HashList({ hashes }: { hashes: { path: string; sha256: string }[] }) {
  return (
    <dl className="tt-hashes">
      {hashes.map((h) => (
        <div key={h.path} style={{ display: 'contents' }}>
          <dt>{h.path}</dt>
          <dd>{h.sha256}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The reference thesis straight from `GET /v1/thesis` (kept for pages that still mount it directly). */
export default function ThesisView() {
  const q = useThesis();
  if (q.isPending) return <ThesisLoading />;
  if (q.isError) return isNotBuilt(q.error) ? <NotBuilt /> : <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <ThesisDocView doc={q.data} isReference />;
}

export { NotBuilt as ThesisNotBuilt };

const orUnknownCmd = (c: string | undefined) => (c && c.trim() ? c : 'unknown');
