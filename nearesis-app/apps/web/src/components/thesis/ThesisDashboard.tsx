"use client";
import "../../lib/zod-config.ts"; // jitless zod: no eval probe under the strict CSP
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
import type { ResearchRunArtifact } from "@nearesis/contracts";
import type { ArtifactsResponse, ThesisData, ThesisSeries } from "./model.ts";
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

type Comparison = ResearchRunArtifact["estimates"]["primary"];
const num = (v: number | null | undefined, d = 4) =>
  v === null || v === undefined || !Number.isFinite(v) ? "not reported" : v.toFixed(d);

/**
 * Research results exactly as the research engine published them (R1 ResearchRunArtifact). Every number is read from
 * the artifact; nothing is recomputed or re-labelled here. Status and evidence strength are separate axes.
 */
function Research({
  r,
  workspaceId,
}: {
  r: Extract<ArtifactsResponse, { status: "available" }>;
  workspaceId: string;
}) {
  const a = r.artifact;
  const fixture = a.claimScope === "synthetic_fixture_only_no_live_claim";
  const comps = Object.entries(a.estimates.byHorizonCandidate)
    .map(([key, c]) => ({ key, ...(c as Comparison) }))
    .sort((x, y) => x.horizon - y.horizon || x.candidate.localeCompare(y.candidate));
  const candidates = [...new Set(comps.map((c) => c.candidate))];
  const horizonSpec: ChartSpec = {
    kind: "bar",
    title: "Out-of-sample MAE improvement over the baseline, by horizon",
    columns: [{ name: "horizon", unit: "days" }, ...candidates.map((c) => ({ name: c, unit: "ΔMAE" }))],
    rows: [...new Set(comps.map((c) => c.horizon))].map((h) => [
      `${h}d`,
      ...candidates.map((c) => comps.find((x) => x.horizon === h && x.candidate === c)?.delta_mae ?? null),
    ]),
    x: { field: "horizon", type: "category" },
    y: candidates.map((c) => ({ field: c, unit: "ΔMAE" })),
  };
  const lag =
    (
      a.falsification as {
        lagComparison?: Record<
          string,
          { delta_mae?: number; relative_improvement?: number | null; n_origins?: number; status?: string }
        >;
      }
    ).lagComparison ?? {};
  const placebo = a.falsification.placebo;
  const supporting = comps.filter((c) => c.fdr_reject === true && (c.delta_mae ?? 0) > 0);
  return (
    <>
      <section className={s.section} aria-labelledby="h-verdict">
        <div className={s.sectionHead}>
          <h2 id="h-verdict">Verdict and hypothesis</h2>
          <ProvenanceChip sourceLabel={a.inputSnapshot.label} data-testid="artifacts-source" />
        </div>
        {fixture ? (
          <HonestyBanner data-testid="fixture-claim-scope">
            Claim scope: synthetic fixture only, no live claim. This run demonstrates the method on labelled
            fixture data; it is not evidence about NEAR.
          </HonestyBanner>
        ) : null}
        <div className={s.grid2}>
          <div className={s.verdict} data-testid="verdict">
            <ClaimTag cls="derived" />
            <span className={s.verdictStatus}>{a.status.replace(/_/g, " ")}</span>
            <span className={s.metricSub}>
              Evidence strength: {a.evidenceStrength.replace(/_/g, " ")} · thresholds from the frozen
              pre-registration
            </span>
            <ul>
              {a.verdict.reasons.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
            <span className={s.metricSub}>
              Experiment {a.experimentId} · method {a.methodVersion} · capsule {r.capsuleId}
            </span>
          </div>
          <div className={s.card}>
            <Claim cls="hypothesis" testId="hypothesis">
              {a.hypothesis.text}
            </Claim>
            <div className={s.metricSub}>
              Primary: {a.hypothesis.primaryComparison} at {a.hypothesis.primaryHorizon}-day horizon · causal
              claim excluded
            </div>
            <div className={s.metricSub} data-testid="preregistration">
              Pre-registration <span className={s.mono}>{a.preregistration.hash}</span> ·{" "}
              {a.preregistrationVerified ? (
                <span className={s.ok}>verified against the frozen record</span>
              ) : (
                <span className={s.bad}>NOT verified</span>
              )}{" "}
              · {a.preregistration.fdr.method.replace(/_/g, "-")} FDR q={a.preregistration.fdr.q} · loss{" "}
              {a.preregistration.loss}
            </div>
          </div>
        </div>
      </section>

      <section className={s.section} aria-labelledby="h-models">
        <div className={s.sectionHead}>
          <h2 id="h-models">Model comparison by horizon (out of sample)</h2>
          <ClaimTag cls="derived" />
        </div>
        <p className={s.sectionNote}>
          ΔMAE &gt; 0 means the candidate forecasts better than the baseline. p-values are Diebold–Mariano
          one-sided, adjusted for the pre-registered test family with Benjamini–Hochberg. Predictive
          comparison only; not causal.
        </p>
        <div className={s.card}>
          <div className={s.chartBox}>
            <Chart spec={horizonSpec} testId="chart-horizons" />
          </div>
          <table className={s.table} data-testid="model-table">
            <thead>
              <tr>
                <th>Horizon</th>
                <th>Candidate</th>
                <th className={s.num}>MAE baseline</th>
                <th className={s.num}>MAE candidate</th>
                <th className={s.num}>ΔMAE (95% CI)</th>
                <th className={s.num}>p (adj.)</th>
                <th>FDR</th>
                <th className={s.num}>Origins</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((c) => (
                <tr key={c.key} id={`result-${c.key.replace(":", "-")}`}>
                  <td>{c.horizon}d</td>
                  <td>{c.candidate}</td>
                  <td className={s.num}>{num(c.mae_baseline)}</td>
                  <td className={s.num}>{num(c.mae_candidate)}</td>
                  <td className={s.num}>
                    {num(c.delta_mae)}
                    {c.delta_mae_ci ? ` (${num(c.delta_mae_ci.lo)} to ${num(c.delta_mae_ci.hi)})` : ""}
                  </td>
                  <td className={s.num}>{num(c.p_adjusted)}</td>
                  <td>
                    {c.fdr_reject === true
                      ? "significant"
                      : c.fdr_reject === false
                        ? "not significant"
                        : "not tested"}
                  </td>
                  <td className={s.num}>{c.n_origins}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={s.section} aria-labelledby="h-falsify">
        <div className={s.sectionHead}>
          <h2 id="h-falsify">Falsification checks</h2>
          <ClaimTag cls="derived" />
        </div>
        <div className={s.grid2}>
          <div className={s.card} data-testid="falsification">
            <h3 className={s.cardTitle}>Placebo test</h3>
            {placebo ? (
              <span className={placebo.passed ? s.ok : s.bad}>
                {placebo.passed ? "Passed" : "Failed"} · p = {num(placebo.p_value)}
              </span>
            ) : (
              <span className={s.warn}>Not run</span>
            )}
          </div>
          <div className={s.card}>
            <h3 className={s.cardTitle}>Lag comparison</h3>
            <table className={s.table} data-testid="lag-table">
              <thead>
                <tr>
                  <th className={s.num}>Lag (days)</th>
                  <th className={s.num}>ΔMAE</th>
                  <th className={s.num}>Relative</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(lag).map(([k, v]) => (
                  <tr key={k}>
                    <td className={s.num}>{k}</td>
                    <td className={s.num}>{num(v.delta_mae)}</td>
                    <td className={s.num}>{num(v.relative_improvement, 3)}</td>
                    <td>{v.status ?? "not reported"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className={s.section} aria-labelledby="h-evidence">
        <div className={s.sectionHead}>
          <h2 id="h-evidence">Evidence and counterevidence</h2>
          <a href={`/w/${workspaceId}/evidence`} data-testid="evidence-graph-link">
            Open the evidence graph
          </a>
        </div>
        <div className={s.grid2}>
          <div className={s.card} data-testid="evidence-bull">
            <h3 className={s.cardTitle}>For the hypothesis</h3>
            <ul className={s.list}>
              {supporting.length ? (
                supporting.map((c) => (
                  <li key={c.key}>
                    <Claim cls="derived" testId={`evidence-item-${c.key}`}>
                      {c.candidate} beats the baseline at {c.horizon}d: ΔMAE {num(c.delta_mae)},
                      FDR-significant (p adj. {num(c.p_adjusted)}).
                      <div className={s.metricSub}>
                        Result <a href={`#result-${c.key.replace(":", "-")}`}>{c.key}</a>
                      </div>
                    </Claim>
                  </li>
                ))
              ) : (
                <li className={s.muted}>No FDR-significant improvement in the published run.</li>
              )}
            </ul>
          </div>
          <div className={s.card} data-testid="evidence-bear">
            <h3 className={s.cardTitle}>Against the hypothesis (counterevidence published by the engine)</h3>
            <ul className={s.list}>
              {a.counterevidence.length ? (
                a.counterevidence.map((c, i) => (
                  <li key={i}>
                    <Claim cls="derived" testId={`counter-item-${i}`}>
                      {c.kind.replace(/_/g, " ")}
                      <div className={s.metricSub}>
                        {Object.entries(c)
                          .filter(([k]) => k !== "kind")
                          .map(([k, v]) => `${k} ${typeof v === "number" ? num(v) : String(v)}`)
                          .join(" · ")}
                      </div>
                    </Claim>
                  </li>
                ))
              ) : (
                <li className={s.muted}>None reported.</li>
              )}
            </ul>
          </div>
        </div>
        <div className={s.grid2}>
          <div className={s.card}>
            <h3 className={s.cardTitle}>Input snapshot</h3>
            <dl className={s.record}>
              <dt>Label</dt>
              <dd>{a.inputSnapshot.label}</dd>
              <dt>Dataset</dt>
              <dd className={s.mono}>{a.inputSnapshot.datasetHash}</dd>
              <dt>Complete</dt>
              <dd className={a.inputSnapshot.complete ? undefined : s.warn}>
                {a.inputSnapshot.complete ? "yes" : "no: coverage is partial"}
              </dd>
              <dt>Rows</dt>
              <dd>
                development {a.inputSnapshot.developmentRows}, post-regime {a.inputSnapshot.postRegimeRows},
                straddle excluded {a.inputSnapshot.straddleRowsExcluded}, dropped{" "}
                {a.inputSnapshot.droppedSamples.count}
              </dd>
              <dt>Lockbox</dt>
              <dd>
                n={a.inputSnapshot.lockbox.n}, {a.inputSnapshot.lockbox.opened ? "opened once" : "sealed"}
              </dd>
              <dt>Regime split</dt>
              <dd>{a.inputSnapshot.regimeSplit}</dd>
            </dl>
          </div>
          <div className={s.card}>
            <h3 className={s.cardTitle}>Research limitations</h3>
            <ul data-testid="research-limitations">
              {a.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        </div>
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
      (artifacts?.status === "available" && artifacts.artifact.inputSnapshot.label === "SYNTHETIC") ? (
        <HonestyBanner data-testid="synthetic-banner">
          SYNTHETIC data:{" "}
          {data?.sourceLabel === "SYNTHETIC"
            ? "series come from labelled fixture snapshots"
            : "series are live"}
          {artifacts?.status === "available" && artifacts.artifact.inputSnapshot.label === "SYNTHETIC"
            ? "; the research run used a labelled synthetic fixture dataset (claim scope: no live claim)"
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
        <Research r={artifacts} workspaceId={workspaceId} />
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
                {artifacts.status === "available" ? (
                  <a
                    className="nz-btn"
                    href={`/w/${workspaceId}/capsule?id=${encodeURIComponent(artifacts.capsuleId)}`}
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
