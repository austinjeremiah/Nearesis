import { candidatesOf, computeResults, decimalPlaces, scaleDecimal } from "@nearesis/capsule";
import type { RunPanel } from "@nearesis/capsule";
import type { PanelDataResponse } from "@nearesis/contracts";
import type { PanelDataPort, DataSource } from "../panel-data.ts";
import { analyticsPanel, semanticPanel } from "../panel-data.ts";
import type { CapsuleFacts, PanelFile } from "./facts.ts";
import { chartData, coverageOf } from "./generate.ts";
import { compareDocs } from "./compare.ts";
import type { CompareRow } from "./compare.ts";
import { RULE, evaluateRule, ppmText } from "./rule.ts";
import type { Doc } from "./verify.ts";

export interface RerunResult {
  outcome: "match" | "drift" | "different" | "incomplete";
  rows: CompareRow[];
  reran: { charts: number; queries: number; at: string; window: { from: string; to: string } };
  unavailable: Array<{ chart: string; reason: string }>;
}

/** The identity the data layer sees: the caller's own organisation and principal, with a scope that names no workspace. */
export interface RerunSession {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  aclClasses: string[];
}

const DAY_MS = 86_400_000;
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const dayStr = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

type Body = Omit<PanelDataResponse, "workspaceId">;

/**
 * Re-executes ONE stored panel query, read-only, with the definition frozen in the capsule snapshot (the stored AST or
 * analytics call, whose time window is absolute) through the same data service that produced it. Returns the panel body or
 * the reason it cannot be re-executed.
 */
async function execPanel(
  port: PanelDataPort,
  session: RerunSession,
  hash: string,
  frozen: PanelFile,
  runSource: DataSource,
): Promise<{ body: Body } | { reason: string }> {
  try {
    const prov = frozen.provenance ?? {};
    let body: Body;
    if (frozen.kind === "analytics") {
      if (!(await port.stored(hash))) return { reason: "QUERY_UNKNOWN" };
      const r = await port.analytics(hash);
      if (r.status !== 200) return { reason: r.body.reasonCode ?? `ANALYTICS_STATUS_${r.status}` };
      body = analyticsPanel(hash, r.body);
      if (body.cannotCompute) {
        const c = body.cannotCompute as { reasonCode?: string; reason?: string };
        return {
          reason: `CANNOT_COMPUTE${c.reasonCode ? `: ${c.reasonCode}` : c.reason ? `: ${c.reason}` : ""}`,
        };
      }
    } else {
      if (!prov.ast) return { reason: "NO_STORED_QUERY" };
      const r = await port.query(session, prov.ast, runSource);
      if (!r.ok) return { reason: r.error.reasonCode ?? "PANEL_DATA_UNAVAILABLE" };
      body = semanticPanel(r.envelope, prov.ast, port.registry(runSource), runSource);
      if (prov.certification === "certified" && body.provenance?.certification === "experimental")
        return { reason: "METRIC_NO_LONGER_CERTIFIED" };
    }
    if (!body.chart) return { reason: "NO_RESULT_TABLE" };
    return { body };
  } catch (e) {
    return { reason: `EXECUTION_FAILED: ${(e as Error).message.slice(0, 160)}` };
  }
}

/**
 * Reproduction by re-execution. Every stored panel query of the thesis's capsule snapshot runs again with the SAME definition
 * and the SAME absolute window; the two verifier series are rebuilt from the SAME panels and columns the original used (no
 * re-picking), `relationship-v1` and each chart's first/last/peak are recomputed and compared with the document. No model
 * call, no chain call. An input that cannot be re-executed is listed and the outcome is `incomplete`; nothing is guessed.
 */
export async function rerunThesis(
  doc: Doc,
  facts: CapsuleFacts,
  port: PanelDataPort,
  session: RerunSession,
  now: Date,
): Promise<RerunResult> {
  const sel = facts.index.selection;
  const runSource: DataSource = facts.index.runSource === "fixture" ? "fixture" : "live";
  const frozenWindow = sel.window;
  const unavailable: RerunResult["unavailable"] = [];
  const bodies = new Map<string, Body>();
  const panels = facts.index.panels;
  for (let i = 0; i < panels.length; i += 4)
    await Promise.all(
      panels.slice(i, i + 4).map(async (pe) => {
        const r = await execPanel(port, session, pe.hash, facts.panels.get(pe.hash) ?? {}, runSource);
        if ("body" in r) bodies.set(pe.hash, r.body);
        else unavailable.push({ chart: pe.title, reason: r.reason });
      }),
    );
  unavailable.sort((a, b) => a.chart.localeCompare(b.chart));

  // charts
  const origCharts = ((doc.charts ?? []) as Doc[]).filter((c) => bodies.has(String(c.queryHash)));
  const reproCharts: Doc[] = [];
  const comparableOrig: Doc[] = [];
  for (const c of origCharts) {
    const cd = chartData(bodies.get(String(c.queryHash)) as unknown as PanelFile);
    if (!cd) {
      unavailable.push({ chart: String(c.title), reason: "NO_NUMERIC_COLUMN" });
      continue;
    }
    comparableOrig.push(c);
    reproCharts.push({
      id: c.id,
      title: c.title,
      x: cd.x,
      series: cd.series.map((s) => ({ name: s.name, values: s.values })),
    });
  }
  for (const c of (doc.charts ?? []) as Doc[])
    if (!bodies.has(String(c.queryHash)) && !unavailable.some((u) => u.chart === String(c.title)))
      unavailable.push({ chart: String(c.title), reason: "QUERY_NOT_RE-EXECUTED" });

  // the two verifier series, same panels and columns, same frozen window
  let test: Doc | null = null;
  let verdict: string | null = null;
  const xBody = bodies.get(sel.x.panelHash);
  const yBody = bodies.get(sel.y.panelHash);
  if (xBody && yBody) {
    const rp = (hash: string, body: Body): RunPanel => ({
      hash,
      title: panels.find((p) => p.hash === hash)?.title ?? hash,
      body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
    });
    const inputs = [
      rp(sel.x.panelHash, xBody),
      ...(sel.x.panelHash === sel.y.panelHash ? [] : [rp(sel.y.panelHash, yBody)]),
    ];
    const { candidates } = candidatesOf(inputs);
    const cx = candidates.find((c) => c.panelHash === sel.x.panelHash && c.column === sel.x.column);
    const cy = candidates.find((c) => c.panelHash === sel.y.panelHash && c.column === sel.y.column);
    if (!cx || !cy) {
      unavailable.push({
        chart: "test series",
        reason: `COLUMN_NOT_AVAILABLE: ${!cx ? sel.x.column : sel.y.column}`,
      });
    } else {
      const lo = dayNum(frozenWindow.from);
      const hi = dayNum(frozenWindow.to);
      const shared = [...cx.values.keys()]
        .filter((d) => d >= lo && d <= hi && cy.values.has(d))
        .sort((a, b) => a - b);
      let best: number[] = [];
      let cur: number[] = [];
      for (const d of shared) {
        cur = cur.length && d === cur[cur.length - 1]! + 1 ? [...cur, d] : [d];
        if (cur.length > best.length) best = cur;
      }
      if (best.length < 2) {
        unavailable.push({ chart: "test series", reason: "FEWER_THAN_TWO_SHARED_DAYS" });
      } else {
        try {
          const xs = best.map((d) => cx.values.get(d)!);
          const ys = best.map((d) => cy.values.get(d)!);
          const px = Math.max(...xs.map(decimalPlaces));
          const py = Math.max(...ys.map(decimalPlaces));
          const n = best.length;
          const input = {
            series: {
              x: {
                ...facts.input.series.x,
                points: best.map((d, i) => [dayStr(d), scaleDecimal(xs[i]!, px).toString()]),
              },
              y: {
                ...facts.input.series.y,
                points: best.map((d, i) => [dayStr(d), scaleDecimal(ys[i]!, py).toString()]),
              },
            },
            metrics: [...(n >= 9 ? ["lag_pearson:7"] : []), "pearson", "summary"],
          };
          const res = computeResults(input as never) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
          const window = { from: dayStr(best[0]!), to: dayStr(best[n - 1]!) };
          const pearsonPpm = res.pearson_ppm == null ? null : BigInt(res.pearson_ppm);
          const lagRaw = res.lag_pearson_ppm?.[String(RULE.lagDays)];
          const lagPpm = lagRaw == null ? null : BigInt(lagRaw);
          const covX = coverageOf(xBody as unknown as PanelFile, window);
          const covY = coverageOf(yBody as unknown as PanelFile, window);
          const coverageComplete =
            covX.complete === null || covY.complete === null ? null : covX.complete && covY.complete;
          verdict = evaluateRule({ n, pearsonPpm, lagPpm, coverageComplete }).status;
          test = {
            n,
            window,
            pearson: pearsonPpm === null ? null : ppmText(pearsonPpm),
            lag: [{ days: RULE.lagDays, value: lagPpm === null ? null : ppmText(lagPpm) }],
          };
        } catch (e) {
          unavailable.push({
            chart: "test series",
            reason: `RECOMPUTATION_FAILED: ${(e as Error).message.slice(0, 160)}`,
          });
        }
      }
    }
  } else {
    unavailable.push({ chart: "test series", reason: "A_PANEL_OF_THE_TEST_COULD_NOT_BE_RE-EXECUTED" });
  }

  const orig: Doc = { charts: comparableOrig };
  const repro: Doc = { charts: reproCharts };
  if (test) {
    orig.verdict = { status: doc.verdict?.status };
    orig.test = doc.test;
    repro.verdict = { status: verdict };
    repro.test = test;
  }
  const cmp = compareDocs(orig, repro);
  const rows = test ? cmp.rows : cmp.rows.filter((r) => r.what !== "verdict");
  return {
    outcome: unavailable.length ? "incomplete" : cmp.outcome,
    rows,
    reran: {
      charts: reproCharts.length,
      queries: panels.length,
      at: now.toISOString(),
      window: frozenWindow,
    },
    unavailable,
  };
}
