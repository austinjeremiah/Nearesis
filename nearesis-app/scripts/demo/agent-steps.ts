/**
 * Demo steps 7-16: question -> agent runtime -> panels -> canvas -> edit -> reopen -> provenance -> audit -> worker
 * crash recovery. Everything runs against the real API/web/Temporal/Postgres. A missing dependency yields BLOCKED with the
 * owner; nothing is simulated. Inference mode is whatever the worker is configured with and is stated in the evidence.
 */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ROOT,
  Recorder,
  api,
  requireFrom,
  spawnLogged,
  waitFor,
  type Child,
  type StepOutcome,
} from "./common.ts";

export interface PgPool {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end(): Promise<void>;
}
export interface Deps {
  rec: Recorder;
  API: string;
  WEB: string;
  adminUrl: string;
  Pool: new (o: { connectionString: string; max: number }) => PgPool;
  ctx: {
    orgId?: string;
    subject?: string;
    token?: string;
    workspaceId?: string;
    runIdAgent?: string;
  };
  webUp: boolean;
  flags: Set<string>;
}

interface CanvasPanel {
  panelId: string;
  kind: string;
  title: string;
  layout: { x: number; y: number; w: number; h: number };
  queryRef: { hash: string; semanticVersion: string };
}
interface RunView {
  state: string;
  version: number;
  failure?: unknown;
}
const TERMINAL = new Set(["COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"]);
const QUESTION =
  "Which certified NEAR Intents metrics changed most over the baseline window? Show completed swaps, total swaps, USD volume and route quote availability as four panels.";

/** A production worker entry (A6). Looked up, never invented: DEMO_WORKER_ENTRY overrides. */
export function findWorkerEntry(): string | null {
  const cands = [
    process.env.DEMO_WORKER_ENTRY,
    "packages/workflow/src/worker-prod.ts",
    "packages/workflow/src/worker-entry.ts",
    "packages/workflow/src/main.ts",
    "apps/worker/src/main.ts",
  ].filter((x): x is string => !!x);
  return cands.find((c) => existsSync(join(APP_ROOT, c))) ?? null;
}

export function startWorker(rec: Recorder, label: string, entry: string): Child {
  return spawnLogged(rec, label, "pnpm", ["exec", "tsx", entry], {
    env: {
      NODE_ENV: "development",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis",
      WORKER_ID: label,
    },
  });
}

export async function agentSteps(
  d: Deps,
  worker: { child: Child | null; entry: string | null },
): Promise<void> {
  const { rec, API, WEB, ctx } = d;
  const token = ctx.token!;
  const ws = ctx.workspaceId!;
  const noWs = !token || !ws;
  const hdr = { token };
  const inference = `INFERENCE_PROVIDER=${process.env.INFERENCE_PROVIDER ?? "unset"}`;
  const getRun = async (id: string) => (await api<RunView>(API, "GET", `/v1/runs/${id}`, hdr)).body;
  const canvas = async () =>
    (
      await api<{
        documentRevision: number;
        dataRevision: number;
        panels: CanvasPanel[];
      }>(API, "GET", `/v1/workspaces/${ws}/canvas`, hdr)
    ).body;
  let blocker: { owner: string; why: string } | null = noWs
    ? { owner: "A11", why: "no workspace from step 3" }
    : null;
  const gated = (n: number, name: string, mode: "fixture-backed" | "live", run: () => Promise<StepOutcome>) =>
    rec.step(n, name, mode, async () =>
      blocker ? { status: "BLOCKED", owner: blocker.owner, detail: blocker.why } : run(),
    );
  const stop = (owner: string, why: string) => (blocker ??= { owner, why });

  // 7 ---------------------------------------------------------------------------------------------------------------
  await rec.step(
    7,
    "Submit a natural-language research instruction (POST /v1/workspaces/:id/questions)",
    "live",
    async () => {
      if (blocker) return { status: "BLOCKED", owner: blocker.owner, detail: blocker.why };
      const r = await api<{ runId?: string; workflowId?: string }>(
        API,
        "POST",
        `/v1/workspaces/${ws}/questions`,
        {
          ...hdr,
          headers: { "idempotency-key": `demo-q-${rec.runId}` },
          body: {
            question: QUESTION,
            snapshotPolicy: "pinned",
            budget: { tokens: 120000, toolCalls: 16, usd: 0.5 },
          },
        },
      );
      if (r.status === 404 || r.status === 501) {
        stop("A7", "questions API missing");
        return {
          status: "BLOCKED",
          owner: "A7",
          detail: `POST /v1/workspaces/${ws}/questions -> ${r.status}`,
        };
      }
      if (r.status !== 202 && r.status !== 201 && r.status !== 200) {
        stop("A7", `questions API returned ${r.status}`);
        return { status: "FAIL", detail: `status ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}` };
      }
      ctx.runIdAgent = r.body.runId;
      return {
        status: "PASS",
        detail: `accepted ${r.status}: runId ${r.body.runId}, workflowId ${r.body.workflowId}; question budget 120000 tokens / 16 tool calls / USD 0.5 (${inference})`,
        facts: { runId: r.body.runId, workflowId: r.body.workflowId, inference },
      };
    },
  );

  // 8 ---------------------------------------------------------------------------------------------------------------
  const states: string[] = [];
  await gated(
    8,
    "Route through the agent runtime (Temporal + LangGraph) and show run states",
    "live",
    async () => {
      const runId = ctx.runIdAgent!;
      if (!worker.child) {
        // Give an externally started worker a short window; otherwise the run cannot progress.
        await new Promise((r) => setTimeout(r, 6000));
        const v = await getRun(runId);
        if (!v.state || v.state === "REQUESTED") {
          stop("A6", "no runtime worker");
          return {
            status: "BLOCKED",
            owner: "A6",
            detail: `run ${runId} has not left REQUESTED (state ${v.state ?? "not yet visible"}) after 6 s: no worker polls the investigation task queue and no production worker entry exists (looked for packages/workflow/src/{worker-prod,worker-entry,main}.ts, apps/worker/src/main.ts, DEMO_WORKER_ENTRY)`,
            facts: { runId, state: v.state },
          };
        }
      }
      let last = "";
      let approvals = 0;
      const t0 = Date.now();
      await waitFor(
        "run terminal state",
        async () => {
          const v = await getRun(runId);
          if (v.state !== last) {
            last = v.state;
            states.push(v.state);
          }
          if (v.state === "APPROVAL_NEEDED") {
            const list = await api<
              | Array<{ approvalId: number; actionHash: string }>
              | { approvals: Array<{ approvalId: number; actionHash: string }> }
            >(API, "GET", `/v1/runs/${runId}/approvals`, hdr);
            const arr = Array.isArray(list.body) ? list.body : (list.body?.approvals ?? []);
            for (const a of arr) {
              const ok = await api(API, "POST", `/v1/runs/${runId}/approvals/${a.approvalId}`, {
                ...hdr,
                body: { decision: "approve", actionHash: a.actionHash },
              });
              if (ok.status < 300) approvals++;
            }
          }
          return TERMINAL.has(v.state);
        },
        Number(process.env.DEMO_RUN_TIMEOUT_MS ?? 240_000),
        1000,
      );
      const admin = new d.Pool({ connectionString: d.adminUrl, max: 2 });
      let events: unknown[];
      try {
        events = (
          await admin.query(
            "SELECT seq, source, kind, from_state, to_state, created_at FROM runtime.run_events WHERE run_id=$1 ORDER BY id",
            [runId],
          )
        ).rows;
      } finally {
        await admin.end();
      }
      rec.writeJson("step08-run-states.json", {
        runId,
        observedStates: states,
        approvalsGranted: approvals,
        runEvents: events,
        ms: Date.now() - t0,
      });
      const ok = last === "COMPLETE" || last === "PARTIAL";
      if (!ok) stop("A6", `run ended ${last}`);
      return {
        status: ok ? "PASS" : "FAIL",
        detail: `run ${runId}: ${states.join(" -> ")}; ${events.length} runtime run events; approvals granted ${approvals}; ${inference}`,
        evidence: ["step08-run-states.json"],
        facts: { runId, states, runEvents: events.length },
      };
    },
  );

  // 9 ---------------------------------------------------------------------------------------------------------------
  let before: Awaited<ReturnType<typeof canvas>> | undefined;
  await gated(9, "Generate four validated analytical panels", "live", async () => {
    before = await canvas();
    const panels = before.panels;
    rec.writeJson("step09-canvas-after-run.json", before);
    const four = panels.length === 4;
    if (!four) stop("A6", `${panels.length} panels on canvas`);
    return {
      status: four ? "PASS" : "FAIL",
      detail: `canvas documentRevision ${before.documentRevision} holds ${panels.length} kernel-validated panels: ${panels.map((p) => `${p.kind}:${String(p.title).slice(0, 40)}`).join("; ")}`,
      evidence: ["step09-canvas-after-run.json"],
      facts: { panelIds: panels.map((p) => p.panelId), documentRevision: before.documentRevision },
    };
  });

  // Browser helpers ---------------------------------------------------------------------------------------------
  type Page = {
    goto(u: string, o?: object): Promise<unknown>;
    waitForSelector(s: string, o?: object): Promise<unknown>;
    waitForFunction(f: string, a?: unknown, o?: object): Promise<unknown>;
    screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
    locator(s: string): { count(): Promise<number> };
  };
  type Browser = {
    newContext(o?: object): Promise<{
      request: { post(u: string, o: object): Promise<{ status(): number }> };
      newPage(): Promise<Page>;
    }>;
    close(): Promise<void>;
  };
  const shot = async (file: string): Promise<{ count: number; states: string[] }> => {
    const { chromium } = requireFrom<{ chromium: { launch(o: object): Promise<Browser> } }>(
      "apps/web",
      "playwright",
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const login = await c.request.post(`${WEB}/api/dev/login`, { data: { subject: ctx.subject } });
      if (login.status() !== 204) throw new Error(`web dev login ${login.status()}`);
      const page = await c.newPage();
      await page.goto(`${WEB}/w/${ws}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid^="panel-"]', { timeout: 90_000 });
      await page.waitForFunction(
        'document.querySelectorAll(\'[data-panel-state="LOADING"],[data-panel-state="loading"]\').length===0',
        undefined,
        { timeout: 90_000 },
      );
      await new Promise((r) => setTimeout(r, 1500));
      const states = await (page as unknown as { evaluate<T>(f: string): Promise<T> }).evaluate<string[]>(
        "[...document.querySelectorAll('[data-testid^=\"panel-\"][data-panel-state]')].map(e=>e.getAttribute('data-panel-state'))",
      );
      await page.screenshot({ path: join(rec.shots, file), fullPage: true });
      return { count: states.length, states };
    } finally {
      await browser.close();
    }
  };

  // 10 --------------------------------------------------------------------------------------------------------------
  await gated(
    10,
    "Display the panels in the interactive canvas (Playwright screenshot)",
    "live",
    async () => {
      if (!d.webUp)
        return {
          status: "BLOCKED",
          owner: "A9",
          detail:
            "web app on :3100 unavailable (--no-web, or the port is held by an unresponsive process; see step 1)",
        };
      const r = await shot("step10-canvas.png");
      const ok = r.count === 4 && r.states.every((s) => s !== "ERROR");
      return {
        status: ok ? "PASS" : "FAIL",
        detail: `canvas rendered ${r.count} panels with states [${r.states.join(", ")}]`,
        evidence: ["screenshots/step10-canvas.png"],
        facts: r,
      };
    },
  );

  // 11 --------------------------------------------------------------------------------------------------------------
  let edit: { panelId: string; layout: Record<string, number>; revisionAfter: number } | undefined;
  await gated(11, "Change a filter or layout", "live", async () => {
    const doc = await canvas();
    const p = doc.panels[0]!;
    const layout = { ...p.layout, w: Math.min(48, Number(p.layout.w) + 2), h: Number(p.layout.h) + 1 };
    const wsView = await api<{ version: number }>(API, "GET", `/v1/workspaces/${ws}`, hdr);
    const r = await api<{ workspaceVersion: number; eventSeq: number }>(
      API,
      "POST",
      `/v1/workspaces/${ws}/commands`,
      {
        ...hdr,
        headers: { "if-match": String(wsView.body.version) },
        body: {
          apiVersion: "v1",
          commandId: randomUUID(),
          commandType: "canvas.apply_patch",
          expectedVersion: wsView.body.version,
          payload: {
            schemaVersion: 1,
            type: "workspace.patch",
            operationId: randomUUID(),
            expectedRevision: doc.documentRevision,
            operations: [{ op: "movePanel", panelId: p.panelId, layout }],
          },
        },
      },
    );
    const after = await canvas();
    const moved = after.panels.find((x) => x.panelId === p.panelId)?.layout;
    const ok = r.status === 200 || r.status === 202 || r.status === 201;
    const matches = JSON.stringify(moved) === JSON.stringify(layout);
    edit = { panelId: p.panelId, layout, revisionAfter: after.documentRevision };
    rec.writeJson("step11-layout-edit.json", {
      commandStatus: r.status,
      panelId: p.panelId,
      layoutBefore: p.layout,
      layoutAfter: moved,
      documentRevisionBefore: doc.documentRevision,
      documentRevisionAfter: after.documentRevision,
    });
    if (!(ok && matches)) stop("A7", "layout edit not applied");
    return {
      status: ok && matches && after.documentRevision === doc.documentRevision + 1 ? "PASS" : "FAIL",
      detail: `canvas.apply_patch movePanel ${p.panelId}: HTTP ${r.status}; documentRevision ${doc.documentRevision} -> ${after.documentRevision}; layout ${JSON.stringify(p.layout)} -> ${JSON.stringify(moved)}`,
      evidence: ["step11-layout-edit.json"],
      facts: { commandStatus: r.status },
    };
  });

  // 12 / 13 ---------------------------------------------------------------------------------------------------------
  await gated(12, "Save and reopen the workspace", "live", async () => {
    if (!d.webUp)
      return {
        status: "BLOCKED",
        owner: "A9",
        detail:
          "web app on :3100 unavailable (--no-web, or the port is held by an unresponsive process; see step 1)",
      };
    const r = await shot("step12-reopened.png");
    return {
      status: r.count === 4 ? "PASS" : "FAIL",
      detail: `fresh browser session and login reopened the workspace; ${r.count} panels rendered (changes are saved server-side by the kernel command)`,
      evidence: ["screenshots/step12-reopened.png"],
      facts: r,
    };
  });
  await gated(13, "Confirm panels and edits persist (exact revision and IDs)", "live", async () => {
    const doc = await canvas();
    const idsBefore = (before?.panels ?? []).map((p) => p.panelId).sort();
    const idsAfter = doc.panels.map((p) => p.panelId).sort();
    const layoutOk =
      JSON.stringify(doc.panels.find((p) => p.panelId === edit?.panelId)?.layout) ===
      JSON.stringify(edit?.layout);
    const ok =
      JSON.stringify(idsBefore) === JSON.stringify(idsAfter) &&
      layoutOk &&
      doc.documentRevision === edit?.revisionAfter;
    rec.writeJson("step13-persistence.json", {
      documentRevision: doc.documentRevision,
      expectedRevision: edit?.revisionAfter,
      panelIds: idsAfter,
      editedPanel: edit,
    });
    return {
      status: ok ? "PASS" : "FAIL",
      detail: `after reopen: documentRevision ${doc.documentRevision} (expected ${edit?.revisionAfter}); panel IDs identical (${idsAfter.length}); edited layout of ${edit?.panelId} persisted: ${layoutOk}`,
      evidence: ["step13-persistence.json"],
    };
  });

  // 14 --------------------------------------------------------------------------------------------------------------
  await gated(14, "Inspect provenance and source freshness of the panels", "fixture-backed", async () => {
    const doc = await canvas();
    const admin = new d.Pool({ connectionString: d.adminUrl, max: 2 });
    const rows: unknown[] = [];
    let ok = true;
    try {
      for (const p of doc.panels) {
        const hash = String(p.queryRef.hash);
        const reg = await admin.query(
          "SELECT semantic_version, semantic_model_hash FROM analytics_meta.query_registry WHERE query_hash=$1",
          [hash],
        );
        const web = d.webUp
          ? await fetch(`${WEB}/api/semantic/panel/${hash}?workspace=${ws}`, {
              headers: { cookie: `nearesis_session=${token}` },
            })
          : null;
        const body = web
          ? ((await web.json()) as { chart?: { freshness?: string; sourceWatermark?: string | null } })
          : null;
        const row = {
          panelId: p.panelId,
          queryHash: hash,
          semanticVersion: p.queryRef.semanticVersion,
          registry: reg.rows[0] ?? null,
          webStatus: web?.status ?? null,
          freshness: body?.chart?.freshness ?? null,
          sourceWatermark: body?.chart?.sourceWatermark ?? null,
        };
        if (!reg.rows[0] || (web && web.status !== 200) || !row.sourceWatermark) ok = false;
        rows.push(row);
      }
    } finally {
      await admin.end();
    }
    rec.writeJson("step14-provenance.json", rows);
    return {
      status: ok ? "PASS" : "FAIL",
      detail: `${rows.length} panels: each has a registered query hash, a semantic version and a source watermark/freshness from the gateway (see evidence)`,
      evidence: ["step14-provenance.json"],
    };
  });

  // 15 --------------------------------------------------------------------------------------------------------------
  await rec.step(
    15,
    "Verify audit records (kernel audit_events, workspace events, runtime run events)",
    "live",
    async () => {
      if (!ctx.orgId || !ws) return { status: "BLOCKED", detail: "no workspace", owner: "A11" };
      const admin = new d.Pool({ connectionString: d.adminUrl, max: 2 });
      try {
        const wsEvents = await admin.query(
          "SELECT seq, event_type FROM workspace_events WHERE workspace_id=$1 ORDER BY seq",
          [ws],
        );
        const audit = await admin.query(
          "SELECT action, outcome FROM audit_events WHERE workspace_id=$1 OR (org_id=$2 AND workspace_id IS NULL) ORDER BY occurred_at",
          [ws, ctx.orgId],
        );
        const runs = await admin
          .query("SELECT count(*)::int AS n FROM runtime.run_events WHERE tenant_id=$1", [ctx.orgId])
          .catch(() => ({ rows: [{ n: -1 }] }));
        const runEvents = Number(runs.rows[0]?.n ?? -1);
        rec.writeJson("step15-audit.json", {
          workspaceEvents: wsEvents.rows,
          auditEvents: audit.rows,
          runtimeRunEvents: runEvents,
        });
        if (runEvents < 1)
          return {
            status: "BLOCKED",
            owner: "A6",
            detail: `kernel side verified (${wsEvents.rowCount} workspace events [${wsEvents.rows.map((r) => r.event_type).join(", ")}], ${audit.rowCount} audit rows) but 0 runtime run events: no run has executed (see steps 7-9)`,
            evidence: ["step15-audit.json"],
          };
        const hasPatch = wsEvents.rows.some((r) => String(r.event_type).includes("canvas"));
        return {
          status: (wsEvents.rowCount ?? 0) > 0 && hasPatch ? "PASS" : "FAIL",
          detail: `${wsEvents.rowCount} workspace events (canvas events present: ${hasPatch}), ${audit.rowCount} kernel audit rows, ${runEvents} runtime run events for this tenant`,
          evidence: ["step15-audit.json"],
        };
      } finally {
        await admin.end();
      }
    },
  );

  // 16 --------------------------------------------------------------------------------------------------------------
  await rec.step(
    16,
    "Restart (SIGKILL) a worker mid-run; durable recovery without duplicated side effects",
    "live",
    async () => {
      if (noWs || !ctx.runIdAgent)
        return { status: "BLOCKED", owner: "A11", detail: "no workspace or run to build on" };
      if (!worker.child || !worker.entry)
        return {
          status: "BLOCKED",
          owner: "A6",
          detail:
            "no production worker entry the demo can spawn and SIGKILL (looked for packages/workflow/src/{worker-prod,worker-entry,main}.ts, apps/worker/src/main.ts, DEMO_WORKER_ENTRY)",
        };
      const q = await api<{ runId: string }>(API, "POST", `/v1/workspaces/${ws}/questions`, {
        ...hdr,
        headers: { "idempotency-key": `demo-q16-${rec.runId}` },
        body: {
          question: QUESTION + " Also compare against the prior week.",
          snapshotPolicy: "pinned",
          budget: { tokens: 120000, toolCalls: 16, usd: 0.5 },
        },
      });
      if (q.status !== 202 && q.status !== 201)
        return { status: "FAIL", detail: `second question ${q.status}` };
      const runId = q.body.runId;
      await waitFor(
        "run mid-flight",
        async () => {
          const v = await getRun(runId);
          return v.state !== "REQUESTED" && !TERMINAL.has(v.state);
        },
        120_000,
        250,
      );
      const midState = (await getRun(runId)).state;
      const pid = worker.child.proc.pid;
      await worker.child.stop("SIGKILL");
      const killedAt = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 3000));
      worker.child = startWorker(rec, "worker-restarted", worker.entry);
      await waitFor(
        "recovered run terminal",
        async () => TERMINAL.has((await getRun(runId)).state),
        300_000,
        1000,
      );
      const final = await getRun(runId);
      const admin = new d.Pool({ connectionString: d.adminUrl, max: 2 });
      try {
        const dup = await admin.query(
          "SELECT effect_key, count(*)::int AS n FROM runtime.agent_side_effects WHERE run_id=$1 GROUP BY 1 HAVING count(*) > 1",
          [runId],
        );
        const effects = await admin.query(
          "SELECT effect_key, kind, status, provider_calls FROM runtime.agent_side_effects WHERE run_id=$1 ORDER BY created_at",
          [runId],
        );
        const dupCalls = await admin.query(
          "SELECT call_key, count(*)::int AS n FROM runtime.tool_call_log WHERE run_id=$1 GROUP BY 1 HAVING count(*) > 1",
          [runId],
        );
        const patches = await admin.query(
          "SELECT count(*)::int AS n FROM workspace_events WHERE workspace_id=$1 AND event_type LIKE '%canvas%'",
          [ws],
        );
        rec.writeJson("step16-crash-recovery.json", {
          runId,
          midState,
          killedPid: pid,
          killedAt,
          finalState: final.state,
          sideEffects: effects.rows,
          duplicateEffects: dup.rows,
          duplicateToolCalls: dupCalls.rows,
          canvasEvents: patches.rows[0],
        });
        const ok =
          (final.state === "COMPLETE" || final.state === "PARTIAL") && !dup.rowCount && !dupCalls.rowCount;
        writeFileSync(
          join(rec.logs, "step16-note.txt"),
          `worker pid ${pid} SIGKILLed at ${killedAt} while run ${runId} was ${midState}\n`,
        );
        return {
          status: ok ? "PASS" : "FAIL",
          detail: `SIGKILL of worker pid ${pid} while run ${runId} was ${midState}; replacement worker finished it as ${final.state}; ${effects.rowCount} recorded side effects, ${dup.rowCount} duplicated effect keys, ${dupCalls.rowCount} duplicated tool calls`,
          evidence: ["step16-crash-recovery.json", "logs/worker.log", "logs/worker-restarted.log"],
        };
      } finally {
        await admin.end();
      }
    },
  );
}
