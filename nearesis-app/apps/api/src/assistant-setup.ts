import { createHash } from "node:crypto";
import type { InterpretedFinding } from "@nearesis/contracts";
import { KernelError, canWrite, workspaceNotFound } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { loadLiveRegistry, runAnalytics, type AnalyticsDeps } from "@nearesis/analytics";
import type { AnalyticsCapabilityId } from "@nearesis/contracts";
import { insertDraftHypothesis } from "./hypothesis-routes.ts";
import { assertWorkspace, ctxOf } from "./product-common.ts";
import type { RunsService } from "./runs.ts";

/**
 * Assistant setup (Agent tab): after an investigation finished, turn what its findings cite into real, valid workspace objects,
 * as the calling user, through the same kernel commands and service function the manual routes use (same validation, same
 * timeline and audit events). Deterministic: no model call, so it spends nothing.
 *
 *  - markers: DRAFT markers anchored (time_point) on a dated result cell a finding cites, on the canvas panel that shows it.
 *    The cited value is re-read from the same analytics call and must still match, or no marker is made.
 *  - monitor rules: only on certified live metrics the monitor feeder really feeds (see MONITORABLE), compare rules whose
 *    thresholds are the cited daily values. Weekly or monthly values are not comparable to a daily metric and are skipped.
 *  - hypothesis: one DRAFT (never frozen) from the strongest supported finding, with a falsification criterion.
 * Everything is keyed by the run, so a repeat call finds what exists and creates nothing twice.
 */

/** Analytics columns that equal a certified live metric the monitor feeder observes daily (intents trend, day grain). */
const MONITORABLE: Record<string, { metricId: string; noun: string }> = {
  swaps: { metricId: "live.oneclick_swap_count", noun: "daily swaps" },
  volumeUsdKnown: { metricId: "live.oneclick_volume_usd_known", noun: "daily known USD swap volume" },
};
const MAX_PER_KIND = 3;

export interface SetupResult {
  markers: Array<{ id: string; title: string; reason: string }>;
  monitors: Array<{ id: string; title: string; reason: string }>;
  hypothesis: { id: string; title: string } | null;
  skipped: Array<{ kind: "marker" | "monitor" | "hypothesis"; reason: string }>;
  cost: { usd: number; modelCalls: number };
}

export interface SetupDeps {
  kernel: Kernel;
  runs: RunsService;
  analytics: () => AnalyticsDeps;
}

const uuidFrom = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

interface PanelRef {
  panelId: string;
  title: string;
  hash: string;
  /** The analytics call behind the panel; null for a semantic (certified metric) panel. */
  call: { capability: AnalyticsCapabilityId; input: Record<string, unknown> } | null;
  /** Time grain of a semantic panel's query (day, week, ...); null when not recorded. */
  grain: string | null;
}
interface Table {
  columns: Array<{ name: string; type: string; unit: string | null }>;
  rows: Array<Array<string | number | null>>;
}

/** The composer proposal's panels and the analytics calls behind them (the same record the interpretation stage reads). */
function panelsOfProposal(proposal: unknown): PanelRef[] {
  const p = proposal as {
    patch?: { operations?: Array<Record<string, unknown>> };
    analyticsCalls?: Array<{ callHash?: string; capability?: string; input?: unknown }>;
    queries?: Array<{ panelId?: string; query?: { time?: { grain?: string } } }>;
  } | null;
  const grains = new Map(
    (p?.queries ?? []).flatMap((q) =>
      typeof q.panelId === "string" ? [[q.panelId, q.query?.time?.grain ?? null] as const] : [],
    ),
  );
  const calls = new Map(
    (p?.analyticsCalls ?? []).flatMap((c) =>
      typeof c.callHash === "string" ? [[c.callHash, c] as const] : [],
    ),
  );
  const out: PanelRef[] = [];
  for (const op of p?.patch?.operations ?? []) {
    if (op.op !== "addPanel") continue;
    const sp = op.panel as { panelId?: string; title?: string; queryRef?: { hash?: string } } | undefined;
    if (!sp?.panelId || !sp.queryRef?.hash) continue;
    const c = calls.get(sp.queryRef.hash);
    out.push({
      panelId: sp.panelId,
      title: sp.title ?? "Panel",
      hash: sp.queryRef.hash,
      call:
        c && typeof c.capability === "string" && c.input && typeof c.input === "object"
          ? { capability: c.capability as AnalyticsCapabilityId, input: c.input as Record<string, unknown> }
          : null,
      grain: grains.get(sp.panelId) ?? null,
    });
  }
  return out;
}

const numberOf = (v: string): number | null => {
  const n = Number(v.replace(/[,$%\s]/g, ""));
  return Number.isFinite(n) && /\d/.test(v) ? n : null;
};
const num = (c: string | number | null | undefined): number | null =>
  typeof c === "number" ? (Number.isFinite(c) ? c : null) : typeof c === "string" ? numberOf(c) : null;
const sameNumber = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** Display form of a number (titles and reasons only; thresholds keep the exact cited value). */
const pretty = (n: number): string =>
  Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Number(n.toFixed(4)));

const KIND_ORDER: Record<string, number> = { spike: 0, change: 1, trend: 2, comparison: 3 };

/** A dated cell a finding cites: the value as written in the table at that moment, on the panel that shows it. */
interface CitedCell {
  finding: InterpretedFinding;
  panel: PanelRef;
  column: string;
  rowId: string;
  at: string | null;
  value: number;
  cell: string;
}

export async function assistantSetup(
  deps: SetupDeps,
  s: Session,
  workspaceId: string,
  runId: string,
  traceId: string,
): Promise<SetupResult> {
  const { kernel } = deps;
  if (!canWrite(s.role))
    throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot make this change.");
  // Existence hiding: an inaccessible or unknown workspace is the same 404 as everywhere else.
  try {
    await kernel.workspaces.get(s, workspaceId);
  } catch (e) {
    if (e instanceof KernelError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND"))
      throw workspaceNotFound();
    throw e;
  }
  let run: Awaited<ReturnType<RunsService["getRun"]>>;
  try {
    run = await deps.runs.getRun(s, runId);
  } catch (e) {
    if (e instanceof KernelError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN"))
      throw new KernelError("NOT_FOUND", "RUN_NOT_IN_WORKSPACE", "No such run in this workspace.");
    throw e;
  }
  if (run.workspaceId !== workspaceId)
    throw new KernelError("NOT_FOUND", "RUN_NOT_IN_WORKSPACE", "No such run in this workspace.");
  if (run.state !== "COMPLETE")
    throw new KernelError("VALIDATION_FAILED", "RUN_NOT_COMPLETE", `The run is ${run.state}, not COMPLETE.`);
  if (run.interpretation.state !== "ready" || !run.findings.length)
    throw new KernelError(
      "VALIDATION_FAILED",
      "INTERPRETATION_NOT_READY",
      "The run has no ready interpretation to set up from.",
    );

  const result: SetupResult = {
    markers: [],
    monitors: [],
    hypothesis: null,
    skipped: [],
    cost: { usd: 0, modelCalls: 0 },
  };
  const skip = (kind: SetupResult["skipped"][number]["kind"], reason: string) =>
    void result.skipped.push({ kind, reason });

  const proposal = await kernel.db.tx(ctxOf(s), async (tx) => {
    const r = await tx.query<{ proposal: unknown }>(
      "SELECT result->'result'->'proposal' AS proposal FROM runtime.tasks WHERE run_id=$1 AND role='composer' AND status='DONE' ORDER BY created_at LIMIT 1",
      [runId],
    );
    return r.rows[0]?.proposal ?? null;
  });
  const panels = panelsOfProposal(proposal);
  const findings = run.findings
    .filter((f) => f.status === "supported" || f.status === "mixed")
    .sort((a, b) => (KIND_ORDER[a.kind ?? ""] ?? 9) - (KIND_ORDER[b.kind ?? ""] ?? 9));
  if (!findings.length) {
    for (const k of ["marker", "monitor", "hypothesis"] as const)
      skip(k, "No finding of this run is supported or mixed; nothing honest to set up from.");
    return result;
  }

  // Re-read each cited panel's table from its stored call (read-only, cached by the analytics layer).
  const tables = new Map<string, Table | null>();
  const tableOf = async (p: PanelRef): Promise<Table | null> => {
    if (tables.has(p.hash)) return tables.get(p.hash)!;
    let t: Table | null = null;
    if (p.call) {
      try {
        const r = await runAnalytics(deps.analytics(), p.call.capability, p.call.input);
        if (r.ok && r.outcome.outcome === "OK") t = r.outcome.table;
      } catch {
        t = null;
      }
    }
    tables.set(p.hash, t);
    return t;
  };

  // ---- cited dated cells, verified against the re-read table
  const cited: CitedCell[] = [];
  let unreadable = 0;
  for (const f of findings)
    for (const fact of f.facts) {
      const ref = fact.resultRef;
      if (!ref || ref.rowIds.length !== 1) continue;
      const panel = panels.find((p) => p.hash === ref.queryHash);
      if (!panel) continue;
      const rid = ref.rowIds[0]!;
      const stated = numberOf(fact.value);
      if (stated === null) continue;
      let v = stated;
      let cell = fact.value;
      if (panel.call) {
        // analytics panel: the cited value must still be what the same call returns today
        const t = await tableOf(panel);
        if (!t) {
          unreadable += 1;
          continue;
        }
        const ci = t.columns.findIndex((c) => c.name === ref.column);
        const ti = t.columns.findIndex((c) => c.type === "time");
        if (ci < 0 || ti < 0) continue;
        const row = t.rows.find((r) => String(r[ti]) === rid);
        const now = num(row?.[ci]);
        if (!row || now === null || !sameNumber(now, stated)) continue;
        v = now;
        cell = String(row[ci]);
      }
      // a semantic panel's cited value was recomputed from its result cell when the interpretation was made
      const at = /^\d{4}-\d{2}-\d{2}$/.test(rid)
        ? `${rid}T00:00:00Z`
        : /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(rid) && !Number.isNaN(Date.parse(rid))
          ? new Date(Date.parse(rid)).toISOString()
          : null;
      cited.push({ finding: f, panel, column: ref.column, rowId: rid, at, value: v, cell });
    }
  if (unreadable)
    skip(
      "monitor",
      "The cited analytics results could not be re-read just now; thresholds were not derived.",
    );

  const version = async () => (await kernel.workspaces.get(s, workspaceId)).version;
  // ---- markers
  const seenMarker = new Set<string>();
  // spread the markers over the findings: every finding's first dated cell before any finding's second
  const perFinding = new Map<InterpretedFinding, CitedCell[]>();
  for (const c of cited) perFinding.set(c.finding, [...(perFinding.get(c.finding) ?? []), c]);
  const spread: CitedCell[] = [];
  for (let round = 0; spread.length < cited.length; round++)
    for (const list of perFinding.values()) if (list[round]) spread.push(list[round]!);
  for (const c of spread) {
    if (result.markers.length >= MAX_PER_KIND) break;
    if (!c.at) continue;
    const key = `${c.panel.panelId}|${c.at}`;
    if (seenMarker.has(key)) continue;
    seenMarker.add(key);
    const markerId = uuidFrom(`assistant-setup:${runId}:marker:${key}`);
    const title = `${c.panel.title}: ${c.column} on ${c.rowId.slice(0, 10)}`.slice(0, 120);
    const reason =
      `The finding cites ${c.column} = ${pretty(c.value)} on ${c.rowId.slice(0, 10)}: ${c.finding.statement}`.slice(
        0,
        400,
      );
    try {
      const existing = await kernel.monitoring.listMarkers(s, workspaceId, markerId);
      if (!existing.length)
        await kernel.commands.execute(
          s,
          workspaceId,
          {
            apiVersion: "v1",
            commandId: uuidFrom(`assistant-setup:cmd:${runId}:marker:${key}`),
            commandType: "marker.create",
            payload: {
              markerId,
              panelId: c.panel.panelId,
              anchor: { kind: "time_point", at: c.at },
              question: `From the assistant's investigation: ${c.finding.statement}`.slice(0, 4000),
            },
            expectedVersion: await version(),
          },
          { traceId },
        );
      result.markers.push({ id: markerId, title, reason });
    } catch (e) {
      skip(
        "marker",
        `${title}: ${e instanceof KernelError ? `${e.reasonCode} (${e.message})` : "could not be created"}`,
      );
    }
  }
  if (!result.markers.length && !cited.some((c) => c.at))
    skip("marker", "No finding cites a single dated result cell that can anchor a marker.");

  // ---- monitor rules (certified live metrics only; thresholds are the cited daily values)
  const registry = ((): ReturnType<typeof loadLiveRegistry> | null => {
    try {
      return loadLiveRegistry();
    } catch {
      return null;
    }
  })();
  interface Group {
    metricId: string;
    sourceId: string;
    noun: string;
    panel: PanelRef;
    values: number[];
    cells: Map<number, string>;
  }
  const groups = new Map<string, Group>();
  const noMetric = new Set<string>();
  for (const c of cited) {
    let metricId: string | null = null;
    let noun = c.column;
    let daily: boolean;
    if (c.panel.call) {
      const mon = MONITORABLE[c.column];
      const call = c.panel.call;
      daily =
        call.capability === "intents.analyze@1" &&
        call.input.analysis === "trend" &&
        (call.input.granularity ?? "day") === "day";
      if (mon) {
        metricId = mon.metricId;
        noun = mon.noun;
      }
    } else {
      const m = registry?.metrics.find(
        (x) => x.certified && (x.id === c.column || x.cubeMember === c.column),
      );
      if (m) {
        metricId = m.id;
        noun = m.displayName.replace(/^LIVE /, "").toLowerCase();
      }
      daily = c.panel.grain === "day";
    }
    const m = metricId ? registry?.metrics.find((x) => x.id === metricId && x.certified) : undefined;
    const sourceId = m?.sources[0]?.split(":")[0];
    if (!metricId || !m || !sourceId || !daily) {
      noMetric.add(
        !metricId || !m || !sourceId
          ? `${c.panel.title} (${c.column}): no certified live metric corresponds to this series, so no rule was made from it.`
          : `${c.panel.title} (${c.column}): the series is not daily, and a rule on a daily metric cannot use its values.`,
      );
      continue;
    }
    const g = groups.get(metricId) ?? {
      metricId,
      sourceId,
      noun,
      panel: c.panel,
      values: [] as number[],
      cells: new Map<number, string>(),
    };
    g.values.push(c.value);
    g.cells.set(c.value, c.cell);
    groups.set(metricId, g);
  }
  interface Cand {
    g: Group;
    op: "gt" | "lt";
    value: number;
    cell: string;
  }
  // one downside rule per metric first, then upside rules; a rule needs a cited range (two distinct values)
  const downs: Cand[] = [];
  const ups: Cand[] = [];
  for (const g of groups.values()) {
    const distinct = [...new Set(g.values)];
    if (distinct.length < 2) {
      skip(
        "monitor",
        `${g.metricId}: only one value is cited, and a threshold needs a cited range of at least two values.`,
      );
      continue;
    }
    const lo = Math.min(...distinct);
    const hi = Math.max(...distinct);
    downs.push({ g, op: "lt", value: lo, cell: g.cells.get(lo)! });
    ups.push({ g, op: "gt", value: hi, cell: g.cells.get(hi)! });
  }
  const seenRule = new Set<string>();
  for (const c of [...downs, ...ups]) {
    if (result.monitors.length >= MAX_PER_KIND) break;
    const key = `${c.g.metricId}|${c.op}|${c.value}`;
    if (seenRule.has(key)) continue;
    seenRule.add(key);
    const ruleId = uuidFrom(`assistant-setup:${runId}:rule:${key}`);
    const word = c.op === "gt" ? "above" : "below";
    const title = `${c.g.noun[0]!.toUpperCase()}${c.g.noun.slice(1)} ${word} ${pretty(c.value)}`.slice(
      0,
      200,
    );
    const reason = `Notifies when ${c.g.noun} (${c.g.metricId}, a certified daily metric fed by ${c.g.sourceId}) is ${word} ${pretty(c.value)}, a value the finding cites from "${c.g.panel.title}".`;
    try {
      const existing = (await kernel.monitoring.listRules(s, workspaceId)).some((r) => r.ruleId === ruleId);
      if (!existing)
        await kernel.commands.execute(
          s,
          workspaceId,
          {
            apiVersion: "v1",
            commandId: uuidFrom(`assistant-setup:cmd:${runId}:rule:${key}`),
            commandType: "monitor.rule_create",
            payload: {
              ruleId,
              name: title,
              sourceId: c.g.sourceId,
              condition: { kind: "compare", metricId: c.g.metricId, op: c.op, value: c.value },
              dataMaturity: "finalized_only",
              frequency: { minIntervalSeconds: 0 },
              debounceSeconds: 0,
              cooldownSeconds: 86_400,
              action: "notify",
              enabled: true,
            },
            expectedVersion: await version(),
          },
          { traceId },
        );
      result.monitors.push({ id: ruleId, title, reason });
    } catch (e) {
      skip(
        "monitor",
        `${title}: ${e instanceof KernelError ? `${e.reasonCode} (${e.message})` : "could not be created"}`,
      );
    }
  }
  for (const r of [...noMetric].slice(0, 3)) skip("monitor", r);
  if (!result.monitors.length && !noMetric.size && !cited.length)
    skip("monitor", "No finding cites a single result cell to derive a threshold from.");

  // ---- one DRAFT hypothesis from the strongest supported finding
  const lead = findings.find((f) => f.basis === "observation") ?? findings[0]!;
  const leadCells = cited.filter((c) => c.finding === lead);
  const range = leadCells.length
    ? `${pretty(Math.min(...leadCells.map((c) => c.value)))} to ${pretty(Math.max(...leadCells.map((c) => c.value)))}`
    : null;
  const subject = leadCells[0]
    ? `${leadCells[0].column} in "${leadCells[0].panel.title}"`
    : "the series the finding reads";
  const hypId = uuidFrom(`assistant-setup:${runId}:hypothesis`);
  const proposition =
    `Expectation from the completed investigation (a description of the data, not a causal claim): ${lead.statement}`.slice(
      0,
      4000,
    );
  const falsification =
    `The expectation is falsified if the same analysis, rerun on newer complete days, no longer shows the stated reading` +
    (range
      ? ` (the cited values ranged from ${range}; later values that reverse the stated direction count against it)`
      : "") +
    `, or if a source revision or coverage change removes the rows it rests on.`;
  try {
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, workspaceId);
      const have = await tx.query<{ proposition: string }>(
        "SELECT proposition FROM hypotheses WHERE id = $1",
        [hypId],
      );
      if (have.rows[0]) return { id: hypId, title: have.rows[0].proposition };
      const v = await insertDraftHypothesis(
        tx,
        s,
        ws,
        {
          proposition,
          target: subject.slice(0, 2000),
          predictor: "None stated: a descriptive expectation, not a causal claim.",
          benchmark: "The same series over the preceding window of equal length.",
          falsification: falsification.slice(0, 4000),
        },
        hypId,
      );
      return { id: v.hypothesisId, title: v.proposition };
    });
    result.hypothesis = { id: out.id, title: out.title.slice(0, 300) };
  } catch (e) {
    skip("hypothesis", e instanceof KernelError ? `${e.reasonCode} (${e.message})` : "could not be created");
  }
  return result;
}
