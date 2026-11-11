"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Chart,
  type ChartSpec,
  EmptyState,
  ErrorState,
  HonestyBanner,
  ProvenanceChip,
} from "@nearesis/ui";
import { hashCanonical } from "@nearesis/canvas-schema";
import { Claim, ClaimLegend, ClaimTag } from "./ClaimTag.tsx";
import type { ArtifactsResponse, ResearchArtifacts, ThesisData, ThesisSeries } from "./model.ts";
import s from "./thesis.module.css";

const DAY = 86_400_000;
const QUESTION = "Is NEAR Intents activity a better leading indicator of adoption than NEAR token price?";
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function defaultWindow(): { from: string; to: string } {
  const to = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - DAY;
  return { from: isoDay(to - 89 * DAY), to: isoDay(to) };
}

function latest(sr: ThesisSeries): { value: number; day: string } | null {
  for (let i = sr.rows.length - 1; i >= 0; i--) {
    const [d, v] = sr.rows[i]!;
    if (v !== null) return { value: v, day: d };
  }
  return null;
}

/** One-sentence description of what was observed. Deterministic; never an interpretation or a forecast. */
function observedSentence(sr: ThesisSeries): string {
  const l = latest(sr);
  if (!l) return `No ${sr.label.toLowerCase()} values were observed in this window.`;
  const vals = sr.rows.map((r) => r[1]).filter((v): v is number => v !== null);
  return `Observed on ${sr.coverage.observedDays} of ${sr.coverage.expectedDays} days; range ${fmt.format(Math.min(...vals))} to ${fmt.format(Math.max(...vals))} ${sr.unit ?? ""}, latest ${fmt.format(l.value)} on ${l.day}.`;
}

function seriesSpec(sr: ThesisSeries): ChartSpec {
  return {
    kind: sr.key === "volume" || sr.key === "swaps" ? "bar" : "line",
    title: sr.label,
    columns: [
      { name: "day", unit: null },
      { name: sr.key, unit: sr.unit },
    ],
    rows: sr.rows.map(([d, v]) => [d, v]),
    x: { field: "day", type: "time" },
    y: [{ field: sr.key, unit: sr.unit }],
    gaps: sr.gaps,
  };
}

/** Indexed comparison (each series = 100 at its first observed day). Missing days stay null, so lines break. */
function comparisonSpec(series: ThesisSeries[]): ChartSpec {
  const days = [...new Set(series.flatMap((x) => x.rows.map((r) => r[0])))].sort();
  const maps = series.map((x) => new Map(x.rows));
  return {
    kind: "line",
    title: "Intents activity, adoption and price (indexed)",
    columns: [{ name: "day", unit: null }, ...series.map((x) => ({ name: x.key, unit: x.unit }))],
    rows: days.map((d) => [d, ...maps.map((m) => m.get(d) ?? null)]),
    x: { field: "day", type: "time" },
    y: series.map((x) => ({ field: x.key, unit: x.unit })),
    scale: "index_100",
  };
}

function ChartRecord({
  sr,
  computation,
  interpretation,
  window,
}: {
  sr: ThesisSeries | ThesisSeries[];
  computation: string;
  interpretation: string;
  window: { from: string; to: string };
}) {
  const list = Array.isArray(sr) ? sr : [sr];
  return (
    <details className={s.record} data-testid="chart-record">
      <summary>Chart record: source, query, definition, window, snapshot, computation, limitations</summary>
      <dl>
        <dt>Source</dt>
        <dd>{[...new Set(list.flatMap((x) => x.provenance.sources))].join(", ") || "unknown"}</dd>
        <dt>Certified query</dt>
        <dd>
          {list.map((x) => (
            <div key={x.key} className={s.mono}>
              {x.member} · semantic {x.provenance.semanticVersion} · query{" "}
              {x.provenance.queryHash || "not executed"}
            </div>
          ))}
        </dd>
        <dt>Metric definition</dt>
        <dd>
          {list.map((x) => (
            <div key={x.key}>{x.definition}</div>
          ))}
        </dd>
        <dt>Date window</dt>
        <dd>
          {window.from} to {window.to} (UTC days, inclusive)
        </dd>
        <dt>Data snapshot</dt>
        <dd className={s.mono}>
          {[...new Set(list.map((x) => x.provenance.sourceSnapshotId ?? "live (no frozen snapshot)"))].join(
            ", ",
          )}
        </dd>
        <dt>Result hash</dt>
        <dd className={s.mono}>{list.map((x) => x.provenance.resultHash || "none").join(" · ")}</dd>
        <dt>Computation</dt>
        <dd>{computation}</dd>
        <dt>Interpretation</dt>
        <dd>
          <ClaimTag cls="observed" /> {interpretation}
        </dd>
        <dt>Limitations</dt>
        <dd>
          {list.map((x) => (
            <div key={x.key}>{x.limitation}</div>
          ))}
        </dd>
      </dl>
    </details>
  );
}

function SeriesCard({ sr, window }: { sr: ThesisSeries; window: { from: string; to: string } }) {
  const spec = useMemo(() => seriesSpec(sr), [sr]);
  return (
    <section className={s.card} aria-labelledby={`h-${sr.key}`} data-testid={`series-${sr.key}`}>
      <div className={s.sectionHead}>
        <h3 className={s.cardTitle} id={`h-${sr.key}`}>
          {sr.label}
        </h3>
        <ClaimTag cls="observed" />
      </div>
      {sr.error ? (
        <ErrorState code={sr.error.code} message={sr.error.message} />
      ) : sr.rows.length === 0 ? (
        <EmptyState title="No rows for this window" art={false}>
          An empty result is not a zero series. Coverage: {sr.coverage.observedDays}/
          {sr.coverage.expectedDays} days.
        </EmptyState>
      ) : (
        <div className={s.chartBox}>
          <Chart spec={spec} testId={`chart-${sr.key}`} />
        </div>
      )}
      <ChartRecord
        sr={sr}
        window={window}
        computation="None: values as returned by the certified query (daily grain)."
        interpretation={observedSentence(sr)}
      />
    </section>
  );
}

function Coverage({ sr }: { sr: ThesisSeries }) {
  const c = sr.coverage;
  return (
    <div className={s.metricSub} data-testid={`coverage-${sr.key}`}>
      <meter
        min={0}
        max={c.expectedDays}
        value={c.observedDays}
        aria-label={`${c.observedDays} of ${c.expectedDays} days observed`}
      />{" "}
      {c.observedDays}/{c.expectedDays} days observed
      {c.missingDays ? <span className={s.warn}> · {c.missingDays} missing (not zero)</span> : null}
      {c.partialDays ? <span className={s.warn}> · {c.partialDays} partial</span> : null}
    </div>
  );
}

function Research({ a, workspaceId }: { a: ResearchArtifacts; workspaceId: string }) {
  const pairs = [...new Set(a.lagResults.map((r) => `${r.leader} → ${r.follower}`))];
  const lagSpec: ChartSpec | null = a.lagResults.length
    ? {
        kind: "bar",
        title: "Lagged correlation by lead (days)",
        columns: [{ name: "lag", unit: "days" }, ...pairs.map((p) => ({ name: p, unit: "corr" }))],
        rows: [...new Set(a.lagResults.map((r) => r.lagDays))]
          .sort((x, y) => x - y)
          .map((lag) => [
            String(lag),
            ...pairs.map(
              (p) =>
                a.lagResults.find((r) => r.lagDays === lag && `${r.leader} → ${r.follower}` === p)
                  ?.estimate ?? null,
            ),
          ]),
        x: { field: "lag", type: "category" },
        y: pairs.map((p) => ({ field: p, unit: "corr" })),
      }
    : null;
  const byResult = new Map(a.lagResults.map((r) => [r.id, r]));
  return (
    <>
      <section className={s.section} aria-labelledby="h-verdict">
        <div className={s.sectionHead}>
          <h2 id="h-verdict">Verdict and hypothesis</h2>
          <ProvenanceChip sourceLabel={a.sourceLabel} data-testid="artifacts-source" />
        </div>
        <div className={s.grid2}>
          <div className={s.verdict} data-testid="verdict">
            <ClaimTag cls="interpretation" />
            <span className={s.verdictStatus}>
              {a.verdict ? a.verdict.status.replace("_", " ") : "No verdict recorded"}
            </span>
            <span className={s.muted}>
              {a.verdict?.summary ?? "The research run has not produced a verdict."}
            </span>
            <span className={s.metricSub}>
              {a.producer} · {a.producedAt} · artifact set {a.artifactSetId}
            </span>
          </div>
          <div className={s.card}>
            <Claim cls="hypothesis" testId="hypothesis">
              {a.hypothesis.statement}
            </Claim>
            <div className={s.metricSub}>
              Pre-registration:{" "}
              {a.hypothesis.preregistrationHash ? (
                <span className={s.mono}>
                  {a.hypothesis.preregistrationHash} ({a.hypothesis.preregisteredAt})
                </span>
              ) : (
                <span className={s.warn}>not pre-registered</span>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className={s.section} aria-labelledby="h-falsify">
        <div className={s.sectionHead}>
          <h2 id="h-falsify">Falsification criteria</h2>
        </div>
        <table className={s.table} data-testid="falsification">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Status</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {a.hypothesis.falsification.map((f) => (
              <tr key={f.id}>
                <td>{f.criterion}</td>
                <td
                  className={
                    f.status === "triggered" ? s.bad : f.status === "not_evaluated" ? s.warn : undefined
                  }
                >
                  {f.status.replace("_", " ")}
                </td>
                <td className={s.mono}>{f.resultId ?? "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={s.section} aria-labelledby="h-lag">
        <div className={s.sectionHead}>
          <h2 id="h-lag">Lag analysis</h2>
          <ClaimTag cls="derived" />
        </div>
        <p className={s.sectionNote}>
          Estimates come from the research engine artifacts. Positive lag means the leader moves first.
          Correlation is not causation.
        </p>
        <div className={s.card}>
          {lagSpec ? (
            <div className={s.chartBox}>
              <Chart spec={lagSpec} testId="chart-lag" />
            </div>
          ) : (
            <EmptyState title="No lag results in the artifact set" art={false} />
          )}
          <table className={s.table} data-testid="lag-table">
            <thead>
              <tr>
                <th>Leader → follower</th>
                <th className={s.num}>Lag (days)</th>
                <th className={s.num}>Estimate</th>
                <th className={s.num}>95% CI</th>
                <th className={s.num}>p</th>
                <th className={s.num}>n</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {a.lagResults.map((r) => (
                <tr key={r.id} id={`result-${r.id}`}>
                  <td>
                    {r.leader} → {r.follower}
                  </td>
                  <td className={s.num}>{r.lagDays}</td>
                  <td className={s.num}>{r.estimate.toFixed(3)}</td>
                  <td className={s.num}>
                    {r.ciLow !== null && r.ciHigh !== null
                      ? `${r.ciLow.toFixed(3)} to ${r.ciHigh.toFixed(3)}`
                      : "not reported"}
                  </td>
                  <td className={s.num}>{r.pValue === null ? "not reported" : r.pValue.toFixed(4)}</td>
                  <td className={s.num}>{r.n}</td>
                  <td>{r.method}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={s.section} aria-labelledby="h-models">
        <div className={s.sectionHead}>
          <h2 id="h-models">Model comparison (out of sample)</h2>
          <ClaimTag cls="derived" />
        </div>
        <table className={s.table} data-testid="model-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Target</th>
              <th>Features</th>
              <th>Holdout</th>
              <th className={s.num}>Metric</th>
              <th className={s.num}>Value</th>
              <th className={s.num}>n</th>
            </tr>
          </thead>
          <tbody>
            {a.models.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name}
                  {m.baseline ? <span className={s.muted}> (baseline)</span> : null}
                </td>
                <td>{m.target}</td>
                <td>{m.features.join(", ") || "none"}</td>
                <td>
                  {m.holdout.from} to {m.holdout.to}
                </td>
                <td className={s.num}>{m.metric}</td>
                <td className={s.num}>{m.value === null ? "not computed" : m.value.toFixed(4)}</td>
                <td className={s.num}>{m.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={s.section} aria-labelledby="h-evidence">
        <div className={s.sectionHead}>
          <h2 id="h-evidence">Evidence and counterevidence</h2>
        </div>
        <div className={s.grid2}>
          {(["bull", "bear"] as const).map((side) => (
            <div key={side} className={s.card} data-testid={`evidence-${side}`}>
              <h3 className={s.cardTitle}>{side === "bull" ? "For the thesis" : "Against the thesis"}</h3>
              <ul className={s.list}>
                {a.evidence
                  .filter((e) => e.side === side)
                  .map((e) => (
                    <li key={e.id}>
                      <Claim
                        cls={
                          e.resultIds.every((id) => byResult.has(id) || a.models.some((m) => m.id === id)) ||
                          e.claimClass === "hypothesis"
                            ? e.claimClass
                            : "unsupported"
                        }
                        testId={`evidence-item-${e.id}`}
                      >
                        {e.text}
                        <div className={s.metricSub}>
                          Results:{" "}
                          {e.resultIds.length
                            ? e.resultIds.map((id) => (
                                <a key={id} href={`#result-${id}`} className={s.mono}>
                                  {id}{" "}
                                </a>
                              ))
                            : "none cited"}
                          {e.graphNodeId ? (
                            <>
                              {" · "}
                              <a
                                href={`/w/${workspaceId}?node=${encodeURIComponent(e.graphNodeId)}`}
                                data-testid="evidence-graph-link"
                              >
                                evidence graph
                              </a>
                            </>
                          ) : null}
                        </div>
                      </Claim>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
        {a.limitations.length ? (
          <div className={s.card}>
            <h3 className={s.cardTitle}>Research limitations</h3>
            <ul>
              {a.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </>
  );
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The report contains exactly the values the page renders, so the export and the UI cannot disagree. */
export function buildReport(data: ThesisData, artifacts: ArtifactsResponse) {
  const body = {
    kind: "nearesis.thesis-report",
    version: 1,
    question: QUESTION,
    window: data.window,
    sourceLabel: data.sourceLabel,
    generatedAt: data.generatedAt,
    series: data.series.map((x) => ({
      key: x.key,
      member: x.member,
      unit: x.unit,
      rows: x.rows,
      coverage: x.coverage,
      gaps: x.gaps,
      provenance: x.provenance,
      definition: x.definition,
      limitation: x.limitation,
    })),
    research: artifacts,
  };
  return { body, sha256: hashCanonical(body) };
}

export function ThesisDashboard({ workspaceId }: { workspaceId: string }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [win, setWin] = useState(() => ({
    from: params.get("from") ?? defaultWindow().from,
    to: params.get("to") ?? defaultWindow().to,
  }));
  const [draft, setDraft] = useState(win);
  const source = params.get("source") === "live" ? "live" : "fixture";
  const [data, setData] = useState<ThesisData | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repro, setRepro] = useState<Record<string, "identical" | "changed"> | null>(null);

  const fetchData = useCallback(
    async (w: { from: string; to: string }): Promise<ThesisData | null> => {
      const r = await fetch(`/w/${workspaceId}/thesis/data?from=${w.from}&to=${w.to}&source=${source}`, {
        cache: "no-store",
      });
      if (!r.ok) {
        setError(`Data request failed (${r.status})`);
        return null;
      }
      return (await r.json()) as ThesisData;
    },
    [workspaceId, source],
  );

  useEffect(() => {
    let live = true;
    setData(null);
    setRepro(null);
    void fetchData(win).then((d) => live && d && setData(d));
    void fetch(`/w/${workspaceId}/thesis/artifacts`, { cache: "no-store" })
      .then((r) =>
        r.ok
          ? (r.json() as Promise<ArtifactsResponse>)
          : { status: "unavailable" as const, reason: `request failed (${r.status})` },
      )
      .then((a) => live && setArtifacts(a));
    return () => {
      live = false;
    };
  }, [win, fetchData, workspaceId]);

  useEffect(() => {
    const ready = data !== null && artifacts !== null;
    (window as unknown as { __thesis?: unknown }).__thesis = ready
      ? { ready, data, artifacts, report: buildReport(data, artifacts) }
      : { ready: false };
  }, [data, artifacts]);

  const checkRepro = useCallback(async () => {
    if (!data) return;
    const again = await fetchData(win);
    if (!again) return;
    setRepro(
      Object.fromEntries(
        data.series.map((x) => [
          x.key,
          again.series.find((y) => y.key === x.key)?.provenance.resultHash === x.provenance.resultHash
            ? "identical"
            : "changed",
        ]),
      ),
    );
  }, [data, fetchData, win]);

  const byKey = (k: string) => data?.series.find((x) => x.key === k);
  const comparison = data
    ? [byKey("swaps"), byKey("tx"), byKey("price")].filter((x): x is ThesisSeries => !!x && !x.error)
    : [];
  const anyMissing = data?.series.some((x) => x.coverage.missingDays > 0);
  const snapshot =
    data?.series.find((x) => x.provenance.sourceSnapshotId)?.provenance.sourceSnapshotId ?? null;

  return (
    <main className={s.page} data-testid="thesis-page">
      <nav className={s.crumbs} aria-label="Breadcrumb">
        <a href={`/w/${workspaceId}`}>Workspace</a>
        <span aria-hidden="true">/</span>
        <span>Investment thesis</span>
      </nav>
      <header className={s.head}>
        <span className={s.eyebrow}>NEAR thesis track · research question</span>
        <h1 className={s.question}>{QUESTION}</h1>
        <p className={s.lede}>
          Observed series come from certified semantic queries with their sources and watermarks. Statistics,
          verdicts and evidence are shown only as published by the research engine. Missing data is shown as
          missing, never as zero.
        </p>
        <ClaimLegend />
        <form
          className={s.toolbar}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.from <= draft.to) setWin(draft);
          }}
          aria-label="Time range"
        >
          <label className={s.field}>
            From (UTC)
            <input
              className="nz-input"
              type="date"
              value={draft.from}
              max={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              data-testid="from"
            />
          </label>
          <label className={s.field}>
            To (UTC)
            <input
              className="nz-input"
              type="date"
              value={draft.to}
              min={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              data-testid="to"
            />
          </label>
          <Button type="submit" data-testid="apply-window">
            Apply
          </Button>
          {[30, 90, 180].map((n) => (
            <Button
              key={n}
              type="button"
              onClick={() => {
                const to = Date.parse(`${win.to}T00:00:00Z`);
                const w = { from: isoDay(to - (n - 1) * DAY), to: win.to };
                setDraft(w);
                setWin(w);
              }}
            >
              {n} days
            </Button>
          ))}
          {data ? <ProvenanceChip sourceLabel={data.sourceLabel} data-testid="data-source" /> : null}
        </form>
      </header>

      {data?.sourceLabel === "SYNTHETIC" ||
      (artifacts?.status === "available" && artifacts.artifacts.sourceLabel === "SYNTHETIC") ? (
        <HonestyBanner data-testid="synthetic-banner">
          SYNTHETIC data:{" "}
          {data?.sourceLabel === "SYNTHETIC"
            ? "series come from labelled fixture snapshots"
            : "series are live"}
          {artifacts?.status === "available" && artifacts.artifacts.sourceLabel === "SYNTHETIC"
            ? "; research results are a labelled test fixture, not research-engine output"
            : ""}
          . Not evidence for the thesis.
        </HonestyBanner>
      ) : null}

      {error ? <ErrorState code="REQUEST_FAILED" message={error} /> : null}
      {!data ? (
        <div className="nz-state" role="status" aria-busy="true" data-testid="thesis-loading">
          Loading certified series…
        </div>
      ) : (
        <>
          <section className={s.section} aria-labelledby="h-core">
            <div className={s.sectionHead}>
              <h2 id="h-core">Core metrics</h2>
              <span className={s.metricSub}>
                {data.window.from} to {data.window.to} · generated {data.generatedAt}
              </span>
            </div>
            <div className={s.metrics} data-testid="core-metrics">
              {data.series.map((x) => {
                const l = latest(x);
                return (
                  <div className={s.metric} key={x.key} data-testid={`metric-${x.key}`}>
                    <span className={s.metricLabel}>{x.label}</span>
                    <span className={s.metricValue}>{l ? fmt.format(l.value) : "No data"}</span>
                    <span className={s.metricSub}>
                      {l ? `${x.unit ?? ""} · latest observed ${l.day}` : "nothing observed in window"}
                    </span>
                    <Coverage sr={x} />
                    <span className={s.metricSub} data-testid={`freshness-${x.key}`}>
                      watermark {x.provenance.watermark ? x.provenance.watermark.slice(0, 10) : "unknown"} ·{" "}
                      {x.provenance.sources.join(", ") || "no source"}
                    </span>
                  </div>
                );
              })}
            </div>
            {anyMissing ? (
              <p className={`${s.sectionNote} ${s.warn}`} data-testid="coverage-warning">
                Coverage is partial: missing days are excluded from every value and chart, not treated as
                zero. Conclusions over this window are limited by that coverage.
              </p>
            ) : null}
            <div className={s.card} data-testid="source-freshness">
              <h3 className={s.cardTitle}>Source freshness</h3>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>State</th>
                    <th>Newest event</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.watermarks).length ? (
                    Object.entries(data.watermarks).map(([p, w]) => (
                      <tr key={p}>
                        <td>{p}</td>
                        <td
                          className={w.state === "fresh" ? s.ok : w.state === "unavailable" ? s.bad : s.warn}
                        >
                          {w.state}
                        </td>
                        <td className={s.mono}>{w.newestEventTime ?? "unknown"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={3} className={s.muted}>
                        No watermarks recorded for this data source.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className={s.section} aria-labelledby="h-compare">
            <div className={s.sectionHead}>
              <h2 id="h-compare">Activity, adoption and price</h2>
              <ClaimTag cls="observed" />
            </div>
            <p className={s.sectionNote}>
              Each series is indexed to 100 at its first observed day in the window so different units share
              one axis. The index is a display transform, not a statistic; shapes do not imply causation.
            </p>
            <div className={s.card} data-testid="comparison">
              {comparison.length >= 2 ? (
                <div className={s.chartBox}>
                  <Chart spec={comparisonSpec(comparison)} testId="chart-comparison" />
                </div>
              ) : (
                <EmptyState title="Not enough observed series to compare" art={false} />
              )}
              <ChartRecord
                sr={comparison}
                window={data.window}
                computation="Index: value ÷ first observed value in window × 100, per series; missing days stay missing."
                interpretation={comparison.map(observedSentence).join(" ")}
              />
            </div>
            <div className={s.grid2}>
              {data.series.map((x) => (
                <SeriesCard key={x.key} sr={x} window={data.window} />
              ))}
            </div>
          </section>
        </>
      )}

      {!artifacts ? null : artifacts.status === "unavailable" ? (
        <section className={s.section} aria-labelledby="h-research">
          <div className={s.sectionHead}>
            <h2 id="h-research">Statistical results</h2>
            <ClaimTag cls="unsupported" />
          </div>
          <EmptyState title="Research results are not available" data-testid="research-unavailable">
            {artifacts.reason} The answer to the question is therefore unknown on this page.
          </EmptyState>
        </section>
      ) : (
        <Research a={artifacts.artifacts} workspaceId={workspaceId} />
      )}

      {data && artifacts ? (
        <section className={s.section} aria-labelledby="h-repro">
          <div className={s.sectionHead}>
            <h2 id="h-repro">Reproducibility and export</h2>
          </div>
          <div className={s.grid2}>
            <div className={s.card}>
              <h3 className={s.cardTitle}>Rebuild</h3>
              <pre className={s.code} data-testid="rebuild-command">
                {snapshot
                  ? `pnpm research:rebuild --snapshot ${snapshot}`
                  : "Live data has no frozen snapshot; freeze one before publishing."}
              </pre>
              <Button onClick={() => void checkRepro()} data-testid="check-repro">
                Re-run queries and compare result hashes
              </Button>
              {repro ? (
                <ul className={s.list} data-testid="repro-result">
                  {Object.entries(repro).map(([k, v]) => (
                    <li key={k}>
                      {k}: <span className={v === "identical" ? s.ok : s.bad}>{v}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className={s.card}>
              <h3 className={s.cardTitle}>Export</h3>
              <p className={s.sectionNote}>
                Exports contain exactly the values shown on this page, with every query hash, window and
                limitation.
              </p>
              <div className={s.toolbar}>
                <Button
                  data-testid="export-json"
                  onClick={() => {
                    const r = buildReport(data, artifacts);
                    download(
                      `thesis-report-${data.window.from}_${data.window.to}.json`,
                      JSON.stringify({ ...r.body, sha256: r.sha256 }, null, 2),
                      "application/json",
                    );
                  }}
                >
                  Report (JSON)
                </Button>
                <Button
                  data-testid="export-csv"
                  onClick={() => {
                    const lines = ["series,member,unit,day,value,query_hash"];
                    for (const x of data.series)
                      for (const [d, v] of x.rows)
                        lines.push(
                          [
                            x.key,
                            x.member,
                            x.unit ?? "",
                            d,
                            v === null ? "" : String(v),
                            x.provenance.queryHash,
                          ].join(","),
                        );
                    download(
                      `thesis-series-${data.window.from}_${data.window.to}.csv`,
                      lines.join("\n"),
                      "text/csv",
                    );
                  }}
                >
                  Series (CSV)
                </Button>
                {artifacts.status === "available" && artifacts.artifacts.capsuleId ? (
                  <a
                    className="nz-btn"
                    href={`/w/${workspaceId}/capsule?id=${encodeURIComponent(artifacts.artifacts.capsuleId)}`}
                    data-testid="capsule-link"
                  >
                    Open research capsule
                  </a>
                ) : (
                  <Badge tone="neutral">No capsule yet</Badge>
                )}
              </div>
              <span className={s.metricSub}>
                Report SHA-256 <span className={s.mono}>{buildReport(data, artifacts).sha256}</span>
              </span>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
