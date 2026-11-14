'use client';

import './thesis-track.css';
import { useState } from 'react';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { SectionBar } from '@/components/nx/section';
import { Button, EmptyState, Notice, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { DataTable } from '@/components/nx/table';
import { SeriesChart } from '@/components/nx/data/charts';
import { useApiGet } from '@/components/nx/data/kit';
import { fInt } from '@/lib/data/num';
import { formatUtc } from '@/lib/format';
import {
  BUILD_COMMAND,
  THESIS_MD_HREF,
  THESIS_PATH,
  THESIS_SITE_HREF,
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
  type ThesisRow,
  type ThesisSection,
} from '@/lib/thesis-track/model';
import MarkdownView from './markdown-view';

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

function Prominent({ kind, title, section }: { kind: 'for' | 'against'; title: string; section: ThesisSection | null }) {
  return (
    <article className={`tt-ev ${kind}`} data-testid={`thesis-evidence-${kind}`}>
      <header>
        <h3>{title}</h3>
      </header>
      <div className="tt-ev-body">
        {section ? (
          <MarkdownView markdown={stripLeadingHeading(section.markdown, section.title)} />
        ) : (
          <p className="small dim" style={{ margin: 0 }}>This section is not in the bundle (unknown).</p>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ verdict */

function Verdict({ t }: { t: Thesis }) {
  const status = t.verdict?.status;
  const tone = statusTone(status);
  const iv = t.verdict?.intentsVsPrice;
  const rows = iv?.rows ?? [];
  return (
    <div className="tt-verdict" data-testid="thesis-verdict" data-tone={tone}>
      <span className="tt-eyebrow">Hypothesis</span>
      <h2 className="tt-hyp">{orUnknown(t.hypothesis)}</h2>
      <div className="tt-status-row">
        <Badge tone={tone}>{statusLabel(status)}</Badge>
        {t.generatedAt && <span className="tiny dim mono">built {formatUtc(t.generatedAt)}</span>}
        {t.version && <span className="tiny dim mono">version {t.version}</span>}
      </div>
      <p className="tt-headline">{orUnknown(t.verdict?.headline)}</p>
      <div className="col gap2">
        <div className="label">Intents vs price</div>
        {iv?.summary && <p className="tt-compare-sum">{iv.summary}</p>}
        {rows.length > 0 ? (
          <DataTable<ThesisRow>
            caption="Intents versus price comparison"
            rows={rows}
            rowKey={(r) => r.label}
            columns={[
              { key: 'l', header: 'Measure', render: (r) => <span className="strong">{r.label}</span> },
              { key: 'v', header: 'Value', numeric: true, render: (r) => <span className="mono">{orUnknown(r.value)}</span> },
              { key: 'u', header: 'Unit', render: (r) => r.unit ?? <span className="dim">unknown</span> },
              { key: 'r', header: 'Source', render: (r) => (r.ref ? <span className="tt-ref">{r.ref}</span> : <span className="dim">unknown</span>) },
            ]}
          />
        ) : (
          <p className="small dim" style={{ margin: 0 }}>No comparison rows in the bundle (unknown).</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ evidence */

function Evidence({ t }: { t: Thesis }) {
  const slots = pickSections(t.sections);
  const mind = t.verdict?.whatWouldChangeOurMind ?? [];
  return (
    <section className="tt-sec" aria-label="Evidence for and against">
      <SectionBar title="Evidence for and against" number="002" />
      <div className="tt-two">
        <Prominent kind="for" title="Evidence for" section={slots.evidenceFor} />
        <Prominent kind="against" title="Evidence against" section={slots.evidenceAgainst} />
      </div>
      <div className="tt-mind" data-testid="thesis-change-mind">
        <header>
          <h3>What would change our mind</h3>
        </header>
        <div className="tt-ev-body">
          {mind.length > 0 ? (
            <ul className="tt-md" style={{ margin: 0, paddingLeft: 20 }}>
              {mind.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          ) : slots.changeMind ? (
            <MarkdownView markdown={stripLeadingHeading(slots.changeMind.markdown, slots.changeMind.title)} />
          ) : (
            <p className="small dim" style={{ margin: 0 }}>Not stated in this bundle (unknown).</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ claims */

function Claims({ t }: { t: Thesis }) {
  const claims = t.claims ?? [];
  const dash = (v: string | null | undefined) => (v ? v : <span className="dim">none stated</span>);
  return (
    <section className="tt-sec" aria-label="Claims">
      <SectionBar title="Claims" number="003" />
      <div className="tt-claims">
        <DataTable
          caption="Claims with verdict, estimate, uncertainty, counterexample and falsification"
          rows={claims}
          rowKey={(c) => c.id}
          empty={{ title: 'No claims in the bundle' }}
          columns={[
            { key: 's', header: 'Statement', render: (c) => <span className="stmt strong">{c.statement}</span> },
            { key: 'k', header: 'Kind', render: (c) => orUnknown(c.kind) },
            { key: 'v', header: 'Verdict', render: (c) => orUnknown(c.verdict) },
            { key: 'e', header: 'Estimate', render: (c) => <span className="mono">{c.estimate ?? 'unknown'}</span> },
            { key: 'u', header: 'Uncertainty', render: (c) => <span className="mono">{c.uncertainty ?? 'unknown'}</span> },
            { key: 'c', header: 'Counterexample', render: (c) => dash(c.counterexample) },
            { key: 'f', header: 'Falsification', render: (c) => dash(c.falsification) },
          ]}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ charts */

function ChartCard({ c }: { c: ThesisChart }) {
  const [open, setOpen] = useState(false);
  const series = chartSeries(c);
  const n = observedPoints(c);
  const tag = queryTag(c);
  const kind = c.kind === 'bar' ? 'bar' : 'line';
  const win = c.window?.from || c.window?.to ? `${c.window?.from ?? 'unknown'} to ${c.window?.to ?? 'unknown'}` : 'unknown';
  const label = `${c.title}. ${c.kind === 'bar' ? 'Bar' : 'Line'} chart${c.unit ? ` in ${c.unit}` : ''}, ${c.x?.length ?? 0} days. ${c.sentence ?? ''}`.trim();
  return (
    <article className="tt-chart" data-testid="thesis-chart" data-chart={c.id}>
      <header>
        <h3>{c.title}</h3>
        <p className="tt-sentence">{orUnknown(c.sentence)}</p>
      </header>
      <div className="tt-chart-body">
        {n > 0 ? (
          <SeriesChart series={series} ariaLabel={label} unit={c.unit ?? undefined} kind={kind} />
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
          <ul className="tt-caveats" aria-label="Caveats">
            {c.caveats.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        )}
        <div className="tt-meta">
          <span><b>Source</b> {orUnknown(c.source)}</span>
          <span><b>Window</b> {win}</span>
          <span><b>Points</b> {fInt(n)}</span>
        </div>
        <div>
          <Button aria-expanded={open} aria-controls={`q-${c.id}`} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide query' : 'Show query'}
          </Button>
        </div>
        {open && (
          <div id={`q-${c.id}`} data-testid="thesis-query">
            <div className="tt-qtag">
              <Badge tone={tag.executed ? 'ok' : 'warn'}>{tag.text}</Badge>
            </div>
            <Sql label="Executed SQL (the local query that produced the data)" sql={c.sqlExecuted} />
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
            { key: 'n', header: 'Table', render: (r) => <span className="mono strong">{r.name}</span> },
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
      <p className="tt-secnote">The tables behind the NEAR thesis and one query you can run yourself. The full thesis is on the NEAR Thesis page.</p>
      <TablesAndSample t={q.data} />
    </section>
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

function Loading() {
  return (
    <div className="tt-skel" data-testid="thesis-loading" aria-busy="true">
      <Skeleton rows={6} />
      <Skeleton rows={8} />
    </div>
  );
}

export default function ThesisView() {
  const q = useThesis();
  if (q.isPending) return <Loading />;
  if (q.isError) return isNotBuilt(q.error) ? <NotBuilt /> : <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  const t = q.data;
  const charts = t.charts ?? [];
  const slots = pickSections(t.sections);
  const hashes = t.reproduce?.hashes ?? [];
  const unable = t.unableToCompute ?? [];
  return (
    <div className="tt" data-testid="thesis-view">
      <section className="tt-sec" aria-label="Verdict">
        <SectionBar title="Verdict" number="001" />
        <Verdict t={t} />
      </section>

      <Evidence t={t} />
      <Claims t={t} />

      <section className="tt-sec" aria-label="Charts">
        <SectionBar title="Charts" number="004" />
        <p className="tt-secnote">Every chart is drawn straight from the frozen data. A day with no value is a gap, not a zero. Each chart carries its query.</p>
        {charts.length === 0 ? (
          <EmptyState title="No charts in the bundle" body="Nothing is drawn when the bundle holds no chart data." />
        ) : (
          <div className="tt-charts">
            {charts.map((c) => (
              <ChartCard key={c.id} c={c} />
            ))}
          </div>
        )}
      </section>

      <section className="tt-sec" aria-label="Reproduce this">
        <SectionBar title="Reproduce this" number="005" />
        <div className="tt-repro" data-testid="thesis-reproduce">
          <div className="col gap2">
            <div className="label">Rebuild every chart from the frozen data</div>
            <CopyBlock text={orUnknownCmd(t.reproduce?.command)} label="build command" />
          </div>
          <div className="col gap2">
            <div className="label">Check the result matches the published hashes</div>
            <CopyBlock text={orUnknownCmd(t.reproduce?.check)} label="verify command" />
          </div>
          <div className="col gap2">
            <div className="label">Hashes</div>
            {hashes.length > 0 ? (
              <dl className="tt-hashes">
                {hashes.map((h) => (
                  <div key={h.path} style={{ display: 'contents' }}>
                    <dt>{h.path}</dt>
                    <dd>{h.sha256}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="small dim" style={{ margin: 0 }}>No hashes in the bundle (unknown).</p>
            )}
          </div>
        </div>
      </section>

      <section className="tt-sec" aria-label="Unable to compute">
        <SectionBar title="Unable to compute" number="006" />
        {unable.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>The bundle lists nothing it was unable to compute.</p>
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
      </section>

      {((t.tables?.length ?? 0) > 0 || t.sampleQuery?.sql) && (
        <section className="tt-sec" aria-label="Tables and sample query">
          <SectionBar title="Tables and sample query" number="007" />
          <TablesAndSample t={t} />
        </section>
      )}

      {slots.rest.length > 0 && (
        <section className="tt-sec" aria-label="Full thesis sections">
          <SectionBar title="The full thesis" number="008" />
          <div data-testid="thesis-sections">
            {slots.rest.map((s) => (
              <details key={s.id} className="tt-acc">
                <summary>{s.title}</summary>
                <div className="tt-acc-body">
                  <MarkdownView markdown={stripLeadingHeading(s.markdown, s.title)} />
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="tt-sec" aria-label="Downloads">
        <SectionBar title="Downloads" number="009" />
        <div className="tt-downloads">
          <a className="btn" href={THESIS_MD_HREF} target="_blank" rel="noopener noreferrer" data-testid="thesis-download-md">
            <Download size={14} /> THESIS.md
          </a>
          <a className="btn" href={THESIS_SITE_HREF} target="_blank" rel="noopener noreferrer" data-testid="thesis-download-site">
            <ExternalLink size={14} /> Static dashboard
          </a>
        </div>
        <Notice tone="info" title="Nothing here is invented">
          Every number comes from a frozen raw file and carries a pointer to it. Anything that could not be computed is listed above with the reason.
        </Notice>
      </section>
    </div>
  );
}

const orUnknownCmd = (c: string | undefined) => (c && c.trim() ? c : 'unknown');
