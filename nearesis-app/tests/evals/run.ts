/**
 * `pnpm evals:run` - the expert evaluation suite (final_master_prompt s19). Every question goes through the real HTTP API
 * (runs are submitted with POST /v1/workspaces/:id/questions, API behaviour is exercised with the same routes the web app
 * calls). Scoring is deterministic: numbers are compared with independent read-only ClickHouse queries, provenance and
 * refusal correctness are structural checks, forbidden claims are regexes, latency and cost are measured. No language model
 * grades anything.
 *
 *   pnpm evals:run [--split dev|heldout|all] [--only Q001,Q007] [--category intents] [--no-runs]
 *                  [--live-model] [--max-usd 0.40] [--concurrency 1] [--timeout-sec 150] [--base-url http://127.0.0.1:4110]
 *                  [--validate-only] [--probes-only] [--no-approve]
 * *
 * Approvals: a pending canvas patch on the fixture-only evaluation workspace (no cost, no network) is approved so that the
 * answer can be judged; --no-approve leaves it pending (the question then fails as "waiting for approval").
 *
 * Inference: the suite does not choose the server's model. `--live-model` only allows a larger spend cap (default USD 1.00,
 * never above 2.50 and never above half of what is left under the global USD 5 ceiling). Without it the cap is USD 0.40; the
 * runner stops submitting runs once the measured spend reaches the cap and marks the rest SKIPPED. If the server turns out
 * to use a paid provider, the summary says so (observed spend > 0 without --live-model).
 * The held-out split exists to detect hardcoding: do not read or tune against it; run it with --split heldout.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "./lib/client.ts";
import { chScalar } from "./lib/clickhouse.ts";
import { QuestionFile } from "./lib/schema.ts";
import type { Question } from "./lib/schema.ts";
import { DIMENSIONS, scoreQuestion } from "./lib/score.ts";
import type { FindingObs, Observation, PanelObs, RunObs, Scored, StepObs } from "./lib/score.ts";
import { runProbe } from "./lib/validators.ts";
import type { ProbeIo } from "./lib/validators.ts";
import { getPath, sleep } from "./lib/util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadQuestions(split: "dev" | "heldout" | "all"): Question[] {
  const files: string[] = [];
  if (split !== "heldout")
    for (const f of readdirSync(join(HERE, "questions"))
      .filter((x) => x.endsWith(".json"))
      .sort())
      files.push(join(HERE, "questions", f));
  if (split !== "dev") files.push(join(HERE, "heldout", "heldout.json"));
  const all = files.flatMap((f) => QuestionFile.parse(JSON.parse(readFileSync(f, "utf8"))));
  const ids = new Set<string>();
  for (const q of all) {
    if (ids.has(q.id)) throw new Error(`duplicate question id ${q.id}`);
    ids.add(q.id);
  }
  return all;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const split = (arg("split") ?? "dev") as "dev" | "heldout" | "all";
  let qs = loadQuestions(split);
  const only = arg("only")?.split(",");
  if (only) qs = qs.filter((q) => only.includes(q.id));
  const cat = arg("category");
  if (cat) qs = qs.filter((q) => q.category === cat);
  if (flag("validate-only")) {
    console.log(`${qs.length} questions valid (${split})`);
    return;
  }
  const base = arg("base-url") ?? "http://127.0.0.1:4110";
  const api = new Api(base);
  const live = flag("live-model");
  const timeoutMs = Number(arg("timeout-sec") ?? 150) * 1000;
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 1));
  const noRuns = flag("no-runs");
  const probesOnly = flag("probes-only");
  const approve = !flag("no-approve");
  let approvals = 0;
  const tag = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);

  // spend envelope: the cap sits inside what is left under the global USD 5 ceiling
  const g0 = ((await api.get("owner", "/v1/cost/global")).body ?? {}) as {
    remainingUsd?: number;
    committedUsd?: number;
  };
  const remaining = g0.remainingUsd ?? 0;
  const cap = Math.min(Number(arg("max-usd") ?? (live ? 1.0 : 0.4)), live ? 2.5 : 0.4, remaining / 2);
  const startCommitted = g0.committedUsd ?? 0;
  let spent = 0;

  // a dedicated workspace keeps eval panels and metric drafts out of the owner's working workspace
  const EVAL_OBJECTIVE = "Nearesis evaluation suite";
  const WS = await (async (): Promise<string> => {
    const list = (
      (await api.get("owner", "/v1/workspaces")).body as {
        workspaces: Array<{ id: string; objective: string }>;
      }
    ).workspaces;
    const found = list.find((w) => w.objective === EVAL_OBJECTIVE);
    if (found) return found.id;
    const c = await api.call(
      "owner",
      "POST",
      "/v1/workspaces",
      { objective: EVAL_OBJECTIVE, networkScope: "fixture-only" },
      { "idempotency-key": "evals-suite-workspace-0001" },
    );
    const id = (c.body as { workspaceId?: string } | null)?.workspaceId;
    if (!id) throw new Error(`could not create the evaluation workspace (${c.status})`);
    const v = ((await api.get("owner", `/v1/workspaces/${id}`)).body as { version: number }).version;
    await api.call("owner", "POST", `/v1/workspaces/${id}/commands`, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "plugin.enable",
      payload: { pluginId: "near-thesis" },
      expectedVersion: v,
    });
    return id;
  })();
  let WS_OTHER = (((await api.get("other", "/v1/workspaces")).body as { workspaces?: Array<{ id: string }> })
    .workspaces ?? [])[0]?.id;
  if (!WS_OTHER) {
    const c = await api.call(
      "other",
      "POST",
      "/v1/workspaces",
      { objective: "evals other tenant", networkScope: "fixture-only" },
      { "idempotency-key": "evals-other-tenant-ws-0001" },
    );
    WS_OTHER = (c.body as { workspaceId?: string } | null)?.workspaceId;
  }
  const sub = (s: string): string =>
    s
      .replaceAll("{WS}", WS)
      .replaceAll("{WS_OTHER}", WS_OTHER ?? "00000000-0000-4000-8000-000000000000")
      .replaceAll("{TAG}", tag);

  const io: ProbeIo = {
    apiGet: async (p) => {
      const r = await api.get("owner", sub(p));
      return { status: r.status, body: r.body };
    },
    chScalar,
  };

  const panelsOf = async (): Promise<Map<string, Record<string, unknown>>> => {
    const c = (await api.get("owner", `/v1/workspaces/${WS}/canvas`)).body as {
      panels?: Array<Record<string, unknown>>;
    } | null;
    return new Map((c?.panels ?? []).map((p) => [String(p.panelId), p]));
  };

  async function observeRun(q: Question): Promise<Pick<Observation, "run" | "error" | "latencyMs">> {
    const as = q.run?.as ?? "owner";
    const ws = as === "other" ? WS_OTHER! : WS;
    const before = await panelsOf();
    const t0 = Date.now();
    const sub_ = await api.call(
      as,
      "POST",
      `/v1/workspaces/${ws}/questions`,
      {
        question: q.prompt,
        snapshotPolicy: q.run?.snapshotPolicy ?? "live",
        source: q.run?.source ?? "live",
        budget: q.run?.budget ?? { tokens: 32000, toolCalls: 12, usd: 3 },
      },
      { "idempotency-key": `evals-${tag}-${q.id}-0000000000` },
    );
    if (sub_.status !== 202) {
      const b = (sub_.body ?? {}) as { reasonCode?: string; message?: string };
      return {
        latencyMs: Date.now() - t0,
        error: `submit refused ${sub_.status} ${b.reasonCode ?? ""}`,
        run: {
          state: "REFUSED_AT_SUBMIT",
          terminal: true,
          failure: {
            reasonCode: b.reasonCode ?? `HTTP_${sub_.status}`,
            humanActionNeeded: b.message ?? null,
          },
          panels: [],
          findings: [],
          spentUsd: 0,
          runId: "",
        },
      };
    }
    const runId = (sub_.body as { runId: string }).runId;
    let w = await api.waitRun(as, runId, timeoutMs);
    // A canvas patch on the fixture-only evaluation workspace costs nothing and touches no network: approving it is what a
    // reviewer would do, and the answer cannot be judged until it is applied. Anything else is left pending and cancelled.
    for (
      let i = 0;
      approve && i < 8 && w.body.state === "APPROVAL_NEEDED" && Date.now() - t0 < timeoutMs;
      i++
    ) {
      const pending =
        (
          (await api.get(as, `/v1/runs/${runId}/approvals`)).body as {
            approvals?: Array<{
              approvalId: string;
              actionHash: string;
              kind: string;
              network: string;
              costLimit: number;
            }>;
          } | null
        )?.approvals ?? [];
      const ok = pending.find(
        (a) => a.kind === "canvas.apply_patch" && a.network === "fixture-only" && a.costLimit === 0,
      );
      if (pending.length && !ok) break;
      if (ok) {
        await api.call(as, "POST", `/v1/runs/${runId}/approvals/${ok.approvalId}`, {
          decision: "approve",
          actionHash: ok.actionHash,
        });
        approvals++;
      }
      await sleep(3000);
      w = await api.waitRun(as, runId, Math.max(5000, timeoutMs - (Date.now() - t0)), ok ? false : true);
    }
    const latencyMs = Date.now() - t0;
    if (w.body.state === "APPROVAL_NEEDED") await api.call(as, "POST", `/v1/runs/${runId}/cancel`, {});
    const after = await panelsOf();
    const panels: PanelObs[] = [...after.values()]
      .filter((p) => !before.has(String(p.panelId)))
      .map((p) => ({
        panelId: String(p.panelId),
        kind: String(p.kind ?? ""),
        title: String(p.title ?? ""),
        fields: [...((getPath(p, "dataBinding.fields") as string[] | undefined) ?? [])],
        queryHash: (getPath(p, "queryRef.hash") as string | undefined) ?? null,
        snapshotPolicy: (getPath(p, "queryRef.snapshotPolicy") as string | undefined) ?? null,
        completeness: (getPath(p, "dataBinding.completeness") as string | undefined) ?? null,
      }));
    const findings: FindingObs[] = (
      (w.body.findings as Array<Record<string, unknown>> | undefined) ?? []
    ).map((f) => ({
      statement: String(f.statement ?? ""),
      factValues: ((f.facts as Array<{ value: string }> | undefined) ?? []).map((x) => String(x.value)),
      allFactsHaveRef: ((f.facts as Array<{ resultRef?: unknown }> | undefined) ?? []).every(
        (x) => !!x.resultRef,
      ),
      hasLimitations:
        ((f.limitations as unknown[] | undefined) ?? []).length > 0 ||
        ((f.skepticNotes as unknown[] | undefined) ?? []).length > 0,
    }));
    const fail = w.body.failure as { reasonCode?: string; humanActionNeeded?: string | null } | null;
    const run: RunObs = {
      state: w.timedOut ? "TIMEOUT" : String(w.body.state),
      terminal: !w.timedOut && w.body.terminal === true,
      failure: fail?.reasonCode
        ? { reasonCode: fail.reasonCode, humanActionNeeded: fail.humanActionNeeded ?? null }
        : null,
      panels,
      findings,
      spentUsd: Number(getPath(w.body, "budget.spent.usd") ?? 0),
      runId,
    };
    return { run, latencyMs };
  }

  async function observeHttp(q: Question): Promise<Pick<Observation, "steps" | "latencyMs">> {
    const t0 = Date.now();
    const steps: StepObs[] = [];
    for (const [i, s] of (q.http ?? []).entries()) {
      const body = s.body === undefined ? undefined : JSON.parse(sub(JSON.stringify(s.body)));
      const r = await api.call(
        s.as,
        s.method,
        sub(s.path),
        body,
        s.method === "POST" ? { "idempotency-key": `evals-${tag}-${q.id}-${i}-0000000` } : {},
      );
      const j = (r.body ?? {}) as Record<string, unknown>;
      const problems: string[] = [];
      if (r.status !== s.expectStatus) problems.push(`status ${r.status}, wanted ${s.expectStatus}`);
      if (s.expectReason && j.reasonCode !== s.expectReason)
        problems.push(`reasonCode ${String(j.reasonCode)}, wanted ${s.expectReason}`);
      for (const e of s.expectBody) {
        const v = getPath(r.body, e.json);
        if (e.equals !== undefined && JSON.stringify(v) !== JSON.stringify(e.equals))
          problems.push(`${e.json} = ${JSON.stringify(v)}`);
        if (e.matches !== undefined && !new RegExp(e.matches, "i").test(String(v)))
          problems.push(`${e.json} does not match ${e.matches}`);
      }
      steps.push({
        index: i,
        status: r.status,
        reasonCode: (j.reasonCode as string | undefined) ?? null,
        traceId: (j.traceId as string | undefined) ?? null,
        bodyText: r.text.slice(0, 4000),
        ok: problems.length === 0,
        detail: problems.join("; "),
      });
    }
    return { steps, latencyMs: Date.now() - t0 };
  }

  async function observe(q: Question): Promise<Observation> {
    if (q.kind === "run" && noRuns)
      return { latencyMs: 0, probes: [], reproduced: null, skipped: "runs disabled (--no-runs)" };
    if (q.kind === "run" && spent >= cap)
      return {
        latencyMs: 0,
        probes: [],
        reproduced: null,
        skipped: `spend cap USD ${cap.toFixed(2)} reached`,
      };
    if (!(await api.waitHealthy(120_000)))
      return { latencyMs: 0, probes: [], reproduced: null, error: "API unreachable for 120s" };
    // tokens may have been invalidated by a restart
    for (const who of ["viewer", "other"] as const) api.forget(who);
    const pre = await Promise.all(
      q.probes.filter((p) => p.kind === "ch_check" && p.precondition).map((p) => runProbe(p, io)),
    );
    const broken = pre.find((r) => !r.ok);
    if (broken)
      return {
        latencyMs: 0,
        probes: pre,
        reproduced: null,
        skipped: `precondition changed (${broken.label}): ${broken.detail}; re-author this question`,
      };
    const part: Partial<Observation> & { latencyMs: number } =
      q.kind === "run" ? await observeRun(q) : await observeHttp(q);
    if (q.kind === "run" && part.run) spent += part.run.spentUsd;
    const probes = await Promise.all(q.probes.map((p) => runProbe(p, io)));
    let reproduced: boolean | null = null;
    if (q.expect.reproducible) {
      const again = await Promise.all(q.probes.map((p) => runProbe(p, io)));
      reproduced =
        again.length > 0 &&
        again.every((a, i) => JSON.stringify(a.observed) === JSON.stringify(probes[i]!.observed));
    }
    return { ...part, probes, reproduced };
  }

  if (probesOnly) {
    let bad = 0;
    for (const q of qs)
      for (const p of q.probes) {
        const r = await runProbe(p, io);
        if (!r.ok) bad++;
        console.log(
          `${q.id} ${r.ok ? "ok  " : "FAIL"} ${r.label}: ${r.detail} (${JSON.stringify(r.observed)} vs ${JSON.stringify(r.expected)})`,
        );
      }
    console.log(`${bad} failing probe(s)`);
    process.exitCode = bad ? 1 : 0;
    return;
  }

  // runs share one workspace canvas, so they are serialised; API-only questions run in parallel
  const results = new Map<string, { q: Question; obs: Observation; scored: Scored }>();
  const runQs = qs.filter((q) => q.kind === "run");
  const httpQs = qs.filter((q) => q.kind === "http");
  const doOne = async (q: Question): Promise<void> => {
    let obs: Observation;
    try {
      obs = await observe(q);
    } catch (e) {
      obs = { latencyMs: 0, probes: [], reproduced: null, error: (e as Error).message };
    }
    const scored = scoreQuestion(q, obs);
    results.set(q.id, { q, obs, scored });
    console.log(
      `${q.id} ${scored.verdict.padEnd(10)} ${q.category.padEnd(20)} ${(scored.score * 100).toFixed(0).padStart(3)}%  ${scored.failures[0] ?? ""}`.slice(
        0,
        200,
      ),
    );
  };
  const queue = [...httpQs];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let q = queue.shift(); q; q = queue.shift()) await doOne(q);
    }),
  );
  for (const q of runQs) await doOne(q);

  const g1 = (await api.get("owner", "/v1/cost/global").then(
    (r) => r.body ?? {},
    () => ({}),
  )) as { committedUsd?: number };
  const observedSpend = (g1.committedUsd ?? 0) - startCommitted;
  const rows = qs.map((q) => results.get(q.id)!.scored);
  const outDir = arg("out") ?? join(HERE, "results", `${tag}-${split}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify(
      {
        tag,
        approvals,
        split,
        base,
        cap,
        observedSpend,
        runSpend: spent,
        rows,
        detail: [...results.values()].map((r) => ({ id: r.q.id, observation: r.obs })),
      },
      null,
      2,
    ),
  );
  const md = summarise({ tag, split, base, cap, live, observedSpend, runSpend: spent, rows, qs });
  writeFileSync(join(outDir, "summary.md"), md);
  console.log(`\n${md}\nresults: ${outDir}`);
}

export interface SummaryInput {
  tag: string;
  split: string;
  base: string;
  cap: number;
  live: boolean;
  observedSpend: number;
  runSpend: number;
  rows: Scored[];
  qs: Question[];
}

export function summarise(i: SummaryInput): string {
  const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(0)}%` : "-");
  const byCat = new Map<string, Scored[]>();
  for (const r of i.rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const L: string[] = [];
  const count = (rs: Scored[], v: string): number => rs.filter((r) => r.verdict === v).length;
  L.push(`# Evaluation summary ${i.tag} (${i.split})`, "");
  L.push(
    `API ${i.base}. Questions ${i.rows.length}. PASS ${count(i.rows, "PASS")}, REFUSED_OK ${count(i.rows, "REFUSED_OK")}, FAIL ${count(i.rows, "FAIL")}, SKIPPED ${count(i.rows, "SKIPPED")}.`,
  );
  L.push(
    `Mean score ${(100 * (i.rows.reduce((a, r) => a + r.score, 0) / Math.max(1, i.rows.length))).toFixed(1)}%. Run spend USD ${i.runSpend.toFixed(4)} (cap ${i.cap.toFixed(2)}); ledger delta USD ${i.observedSpend.toFixed(4)}.`,
  );
  if (!i.live && i.observedSpend > 0.0005)
    L.push(`NOTE: the server spent real money without --live-model, so it is not running a mock provider.`);
  L.push(
    "",
    "PASS = answered with checked evidence (or an API behaved exactly as required). REFUSED_OK = an acceptable honest refusal where an answer was also acceptable. FAIL = any gating dimension failed.",
    "",
  );
  L.push("| category | n | PASS | REFUSED_OK | FAIL | SKIP | mean score |", "|---|---|---|---|---|---|---|");
  for (const [c, rs] of [...byCat].sort())
    L.push(
      `| ${c} | ${rs.length} | ${count(rs, "PASS")} | ${count(rs, "REFUSED_OK")} | ${count(rs, "FAIL")} | ${count(rs, "SKIPPED")} | ${pct(
        rs.reduce((a, r) => a + r.score, 0),
        rs.length,
      )} |`,
    );
  L.push("", "| dimension | applicable | mean |", "|---|---|---|");
  for (const d of DIMENSIONS) {
    const v = i.rows.map((r) => r.dims[d]).filter((x): x is number => x !== null);
    L.push(
      `| ${d} | ${v.length} | ${
        v.length
          ? pct(
              v.reduce((a, x) => a + x, 0),
              v.length,
            )
          : "-"
      } |`,
    );
  }
  L.push(
    "",
    "| id | category | difficulty | verdict | state | score | latency ms | USD | first failure |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of i.rows)
    L.push(
      `| ${r.id} | ${r.category} | ${r.difficulty} | ${r.verdict} | ${r.state ?? r.outcome} | ${(100 * r.score).toFixed(0)}% | ${r.latencyMs} | ${r.usd.toFixed(4)} | ${(r.failures[0] ?? "").replaceAll("|", "/").slice(0, 110)} |`,
    );
  return L.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
