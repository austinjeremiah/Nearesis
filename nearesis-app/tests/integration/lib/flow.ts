/**
 * One workspace, end to end, on the real stack (ch.25 lifecycle, ch.16b B05). Every step is executed by the component
 * that owns it and recorded in the golden trace; the trace recorder (plugins/near-thesis) is product code.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FreezeRefused,
  NEAR_THESIS_DESCRIPTOR,
  registerRunSource,
  PublicationBlocked,
  StepFailure,
  ThesisLifecycle,
  TraceRecorder,
  type GoldenTrace,
  type LifecycleEvent,
  type StepMode,
  type StepName,
} from "../../../plugins/near-thesis/src/index.ts";
import { LIVE_SCENARIO, liveQuery } from "../../../packages/agent-runtime/src/testing/scenarios-live.ts";
import type { RunContextHashes } from "../../../packages/workflow/src/types.ts";
import { buildCapsule, loadSnapshot, verifyCapsule } from "../../../packages/capsule/src/index.ts";
import { execReq, giveLease, grant } from "../../../packages/kernel/test/helpers/index.ts";
import { ExplorerFixtureServer } from "../../../services/ingestion/src/testing/servers.ts";
import { loadPages, setupEnv as setupIngestion } from "../../../services/ingestion/test/helpers/env.ts";
import { evaluate, preregistrationHash, SNAPSHOT_DIR } from "./research.ts";
import { proofStep, type ProofMode, type ProofOutcome } from "./proof.ts";
import { approve, ask, markerCommand, q, waitFor, waitRunDone, waitState, type Stack } from "./stack.ts";

export interface FlowOptions {
  question?: string;
  /** Explorer answers 401 from this page on (planted failing adapter). */
  explorer401?: boolean;
  /** `correct` (default): freeze then evaluate. `late_eval`: evaluate first. `no_approval`: the freeze is attempted without an owner approval. */
  order?: "correct" | "late_eval" | "no_approval";
  /** Replace the component of one step with a mock (negative control for B05(e)). */
  mockStep?: StepName;
  /** Extra text appended to the thesis notes (must pass the publication check). */
  extraNotes?: string[];
  /** Proof leg of the audit step: absent = not attempted. */
  proof?: ProofMode;
  /**
   * Run the semantic layer LIVE (cube-live :4001, nearesis_live, read-only): discovery and a recorded query go through
   * the kernel gateway under a live-source run principal, and the question is submitted with `source: "live"` under
   * the scripted live scenario. Inference stays scripted and labelled `mock`.
   */
  live?: boolean;
}

export interface FlowResult {
  trace: GoldenTrace;
  lifecycle: ThesisLifecycle;
  events: LifecycleEvent[];
  workspaceId: string;
  graph?: { source: string; query: string; model: string; result: string; claim: string };
  runId?: string;
  panelIds: string[];
  /** Live mode only: what discovery and the recorded query returned from the live layer. */
  liveSemantic?: {
    semanticVersion: string;
    source: string;
    metrics: string[];
    queryHash: string;
    measure: string;
    rows: Array<Array<string | number | null>>;
    columns: Array<{ name: string; type?: string }>;
    dataWindows: Record<string, { from: string; to: string } | null>;
  };
  markerId?: string;
  capsuleDir?: string;
  capsuleHash?: string;
  bundleDir?: string;
  artifact?: Record<string, unknown>;
  publication?: { label: string; cap?: string; blockedReason?: string };
  proof?: ProofOutcome;
  /** What the real workflow froze for the run and dispatched to each child (read back from the runtime tables). */
  dispatch?: {
    run: RunContextHashes;
    children: Array<{ taskId: string; role: string; context: RunContextHashes | null }>;
  };
  /** The question text exactly as the API received it (its hash is the run's question hash). */
  postedQuestion?: string;
  headline?: { status: string; deltaMae: number | null };
  texts: Record<string, string>;
}

/** A run id registered as a live-source run, so gateway calls made under it reach cube-live (the worker does the same for real runs). */
function liveProbeRun(register: (runId: string, source: "live") => void): string {
  const id = crypto.randomUUID();
  register(id, "live");
  return id;
}

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `${p}-`));

export async function runFlow(s: Stack, o: FlowOptions = {}): Promise<FlowResult> {
  const question = o.question ?? "Are Intents flows economically durable?";
  const k = s.env.kernel!;
  const lc = new ThesisLifecycle();
  const out: FlowResult = {
    trace: undefined as unknown as GoldenTrace,
    lifecycle: lc,
    events: [],
    workspaceId: "",
    panelIds: [],
    texts: {},
  };
  const mockOr = (
    name: StepName,
    id: string,
    mode: StepMode,
  ): { component: { id: string; version: string }; mode: StepMode } =>
    o.mockStep === name
      ? { component: { id: `${id}.mock`, version: "1" }, mode: "mock" }
      : { component: { id, version: "1" }, mode };

  // 1. Create
  const ws = await k.newWorkspace(`B05 ${question}`);
  out.workspaceId = ws;
  const tr = new TraceRecorder({ traceId: `trace-${ws}`, workspaceId: ws, question, mode: "fixture" });
  await tr.step(
    "create",
    { component: { id: "kernel.workspaces", version: "1" }, mode: "fixture", input: { question } },
    async () => {
      const w = (await s.owner.call("GET", `/v1/workspaces/${ws}`)).json as { version: number };
      return {
        output: { workspaceId: ws, version: w.version, plugins: ["near-thesis"] },
        evidence: [{ kind: "workspace", ref: ws }],
      };
    },
  );

  // 2. Preregister (owner approval is the kernel-resolved role of the approving session)
  const prereg = await tr.step(
    "preregister",
    { component: { id: "research.preregistration", version: "1" }, mode: "fixture", input: { question } },
    async () => {
      const h = preregistrationHash();
      if (o.order !== "late_eval") {
        try {
          lc.freeze(h, o.order === "no_approval" ? null : { approvedBy: k.userId, role: "owner" });
        } catch (e) {
          if (e instanceof FreezeRefused) throw new StepFailure("OWNER_APPROVAL_REQUIRED", e.message);
          throw e;
        }
      }
      return { output: { preregistrationHash: h }, evidence: [{ kind: "preregistration", ref: h }] };
    },
  );

  const preregHash = prereg?.preregistrationHash;
  const scenarioName = o.live ? LIVE_SCENARIO : "A20-P";

  // 3. Acquire: the Explorer collector against the fixture server, plus the frozen raw snapshot
  let snapshotId = "";
  let dataHash = "";
  const ing = await setupIngestion();
  try {
    await tr.step(
      "acquire",
      {
        ...mockOr("acquire", "ingestion.collector", "fixture"),
        input: { source: "explorer.oneclick" },
      },
      async () => {
        const pages = loadPages("fx.explorer.pages-3");
        const server = new ExplorerFixtureServer(ing.clock, pages);
        if (o.explorer401) server.failFrom = { page: 2, status: 401 };
        const r = await ing.collector(server.fetchImpl).run({ maxPages: 5 });
        if (r.status !== "complete")
          throw new StepFailure(
            (r.blocker as { reason_code?: string } | undefined)?.reason_code ?? `COLLECTOR_${r.status}`,
            `explorer collector ended ${r.status} after ${r.pagesCommitted} page(s)`,
          );
        const snap = loadSnapshot(SNAPSHOT_DIR);
        snapshotId = snap.descriptor.snapshotId;
        dataHash = snap.descriptor.files.map((f) => f.sha256).join("");
        return {
          output: { snapshotId, files: snap.descriptor.files.map((f) => f.sha256), pages: r.pagesCommitted },
          evidence: [
            { kind: "snapshot", ref: snapshotId },
            { kind: "collector", ref: `pages:${r.pagesCommitted}` },
          ],
        };
      },
    );
  } finally {
    await ing.close();
  }

  const metricVersions: Record<string, string> = {};
  // 4. Discover through the kernel gateway (real near-thesis plugin, real semantic layer)
  await tr.step(
    "discover",
    { ...mockOr("discover", "semantic.discover", o.live ? "live" : "fixture"), input: { workspace: ws } },
    async () => {
      await giveLease(k.kernel, k.session, ws, "semantic.discover@1", [
        grant({ resource: "semantic", action: "discover" }),
      ]);
      // live: the plugin picks its layer from the run id on the principal; a registered live run id selects cube-live
      const principal = o.live
        ? { ...k.session.principal, parentRunId: liveProbeRun(registerRunSource) }
        : k.session.principal;
      const d = await k.kernel.gateway.invoke(principal, execReq(k.session, ws, "semantic.discover@1", {}));
      if (d.state !== "ok")
        throw new StepFailure(
          "DISCOVER_FAILED",
          `semantic.discover ${d.state} ${JSON.stringify(d).slice(0, 400)}`,
        );
      const p = d.payload as {
        semanticVersion: string;
        semanticModelHash: string;
        source?: string;
        dataWindows?: Record<string, { from: string; to: string } | null>;
        metrics: Array<{ id: string; certifiedVersion?: string }>;
      };
      for (const m of p.metrics) metricVersions[m.id] = m.certifiedVersion ?? p.semanticVersion;
      const evidence = [{ kind: "semantic-model", ref: p.semanticModelHash }];
      let liveHash: string | undefined;
      if (o.live) {
        if (p.source !== "live")
          throw new StepFailure("NOT_LIVE", `discover served source=${String(p.source)}, expected live`);
        await giveLease(k.kernel, k.session, ws, "semantic.query@1", [
          grant({ resource: "semantic", action: "query" }),
        ]);
        const qr = await k.kernel.gateway.invoke(
          principal,
          execReq(k.session, ws, "semantic.query@1", liveQuery()),
        );
        if (qr.state !== "ok")
          throw new StepFailure(
            "LIVE_QUERY_FAILED",
            `semantic.query ${qr.state} ${JSON.stringify(qr).slice(0, 400)}`,
          );
        const qp = qr.payload as {
          ok: boolean;
          queryHash: string;
          envelope: {
            columns: Array<{ name: string; type?: string }>;
            rows: Array<Array<string | number | null>>;
          };
        };
        if (!qp.ok || !qp.envelope.rows.length)
          throw new StepFailure("LIVE_QUERY_EMPTY", "the live query returned no rows");
        out.liveSemantic = {
          semanticVersion: p.semanticVersion,
          source: p.source,
          metrics: p.metrics.map((m) => m.id),
          queryHash: qp.queryHash,
          measure: liveQuery().measures[0]!,
          rows: qp.envelope.rows,
          columns: qp.envelope.columns,
          dataWindows: p.dataWindows ?? {},
        };
        liveHash = qp.queryHash;
        evidence.push({ kind: "live-query", ref: qp.queryHash });
      }
      return {
        output: {
          semanticVersion: p.semanticVersion,
          semanticModelHash: p.semanticModelHash,
          metrics: p.metrics.length,
          ...(liveHash ? { liveQueryHash: liveHash } : {}),
        },
        evidence,
      };
    },
  );

  // 5. Plan: the question enters the real director; the plan is parsed and validated
  let runId = "";
  let workflowId = "";
  await tr.step(
    "plan",
    {
      component: { id: "inference.scripted.director", version: "scripted-1" },
      mode: "mock",
      input: { question, preregHash },
    },
    async () => {
      const r = await ask(s, ws, scenarioName, question, {
        ...(preregHash && /^sha256:[0-9a-f]{64}$/.test(preregHash)
          ? { preregistrationHash: preregHash }
          : {}),
        ...(o.live ? { source: "live" } : {}),
      });
      out.postedQuestion = `[scenario=${scenarioName}] ${question}`;
      runId = r.runId;
      workflowId = r.workflowId;
      out.runId = runId;
      await waitFor(async () => {
        const e = await q<{ n: string }>(
          s.env,
          s.env.tenantId,
          "SELECT count(*)::text n FROM run_events WHERE run_id=$1 AND kind='plan.validated'",
          [runId],
        );
        return Number(e[0]!.n) > 0 ? true : null;
      });
      return { output: { runId, planValidated: true }, evidence: [{ kind: "run", ref: runId }] };
    },
  );

  // 6. Execute: child agents finish; the research engine runs the single final evaluation
  const bundleDir = tmp("bundle");
  out.bundleDir = bundleDir;
  await tr.step(
    "execute",
    { component: { id: "inference.scripted.roles", version: "scripted-1" }, mode: "mock", input: { runId } },
    async () => {
      await waitState(s, runId, ["APPROVAL_NEEDED"]);
      const tasks = await q<{ id: string; role: string; status: string; context: RunContextHashes | null }>(
        s.env,
        s.env.tenantId,
        "SELECT id, role, status, context FROM tasks WHERE run_id=$1 AND depth=1 ORDER BY role",
        [runId],
      );
      // the real workflow froze the run's context and stamped every child it dispatched with it (read back, not recomputed)
      const runRow = await q<{ context: { hashes: RunContextHashes } | null }>(
        s.env,
        s.env.tenantId,
        "SELECT context FROM runs WHERE id=$1",
        [runId],
      );
      if (!runRow[0]?.context) throw new StepFailure("NO_RUN_CONTEXT", "the run froze no dispatch context");
      out.dispatch = {
        run: runRow[0].context.hashes,
        children: tasks.map((t) => ({ taskId: t.id, role: t.role, context: t.context })),
      };
      const { artifact, meta } = evaluate(bundleDir);
      out.artifact = artifact;
      out.headline = {
        status: meta.status,
        deltaMae:
          ((artifact.estimates as { primary?: { delta_mae?: number } } | undefined)?.primary?.delta_mae as
            number | undefined) ?? null,
      };
      const evalHash = String(
        (artifact.artifactHashes as Record<string, string> | undefined)?.estimates ?? meta.status,
      );
      lc.openLockbox({ evaluationHash: evalHash });
      if (o.order === "late_eval") {
        // the freeze comes only after the evaluation
        try {
          lc.freeze(preregHash ?? "", { approvedBy: k.userId, role: "owner" });
        } catch {
          /* recorded by the lifecycle */
        }
      }
      return {
        output: { children: tasks, verdict: meta.status, evidenceStrength: meta.evidenceStrength, evalHash },
        evidence: tasks.map((t) => ({ kind: "task", ref: t.id })),
      };
    },
  );

  // 7. Compose: owner approves the exact canvas patch; the panel is persisted
  await tr.step(
    "compose",
    {
      component: { id: "inference.scripted.composer", version: "scripted-1" },
      mode: "mock",
      input: { runId },
    },
    async () => {
      const hash = await approve(s, runId);
      const res = await waitRunDone(s, runId, workflowId);
      if (res.state !== "COMPLETE") throw new StepFailure("RUN_NOT_COMPLETE", `run ended ${res.state}`);
      const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
        panels: Array<{ panelId: string; queryRef: { hash: string } }>;
      };
      out.panelIds = canvas.panels.map((p) => p.panelId);
      return {
        output: {
          approvalActionHash: hash,
          panels: canvas.panels.map((p) => ({ id: p.panelId, query: p.queryRef.hash })),
        },
        evidence: canvas.panels.map((p) => ({ kind: "panel", ref: p.panelId })),
      };
    },
  );

  // 8. Investigate: a marker on the panel is assigned; exactly one scoped subagent runs
  await tr.step(
    "investigate",
    {
      component: { id: "inference.scripted.marker-agents", version: "scripted-1" },
      mode: "mock",
      input: { panels: out.panelIds },
    },
    async () => {
      const panelId = out.panelIds[0]!;
      const created = await markerCommand(s.owner, ws, "marker.create", {
        markerId: crypto.randomUUID(),
        panelId,
        anchor: { kind: "time_range", start: "2026-10-20T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z" },
        question: "[scenario=basic] Why did swap volume move?",
      });
      if (created.status !== 200)
        throw new StepFailure("MARKER_CREATE_FAILED", JSON.stringify(created.json).slice(0, 200));
      const markers = (await s.owner.call("GET", `/v1/workspaces/${ws}/markers`)).json as {
        markers?: Array<{ markerId: string }>;
      };
      const markerId = markers.markers?.[0]?.markerId;
      if (!markerId) throw new StepFailure("MARKER_MISSING", "marker not listed");
      out.markerId = markerId;
      await markerCommand(s.owner, ws, "marker.transition", { markerId, to: "ACTIVE" });
      const as = await markerCommand(s.owner, ws, "marker.assign", {
        markerId,
        agents: ["quant", "skeptic"],
        grants: [
          "semantic.query@1",
          "semantic.discover@1",
          "stats.read@1",
          "research.run_model@1",
          "evidence.read@1",
          "research.run_bounded_test@1",
        ],
        budget: { tokens: 200_000, toolCalls: 24, usd: 20 },
      });
      if (as.status !== 200)
        throw new StepFailure("MARKER_ASSIGN_FAILED", JSON.stringify(as.json).slice(0, 200));
      const m = await waitFor(async () => {
        await s.owner.call("POST", `/v1/workspaces/${ws}/marker-tasks/dispatch`);
        const r = (await s.owner.call("GET", `/v1/workspaces/${ws}/markers/${markerId}`)).json as {
          status: string;
        };
        return r.status === "REVIEW_REQUIRED" ? r : null;
      }, 120_000);
      const tasks = (await s.owner.call("GET", `/v1/workspaces/${ws}/markers/${markerId}/tasks`)).json as {
        tasks: Array<{ taskId: string; runId: string }>;
      };
      return {
        output: { markerId, status: m.status, tasks: tasks.tasks.map((t) => t.taskId) },
        evidence: tasks.tasks.map((t) => ({ kind: "marker-task", ref: t.taskId })),
      };
    },
  );

  // 9. Monitor: a deterministic watermark rule fires before any agent is scheduled
  await tr.step(
    "monitor",
    { ...mockOr("monitor", "kernel.monitoring", "fixture"), input: { workspace: ws } },
    async () => {
      const ruleId = crypto.randomUUID();
      const sourceId = `quotes.b05.${ruleId.slice(0, 8)}`;
      const v = (await s.owner.call("GET", `/v1/workspaces/${ws}`)).json as { version: number };
      const r = await s.owner.call("POST", `/v1/workspaces/${ws}/commands`, {
        apiVersion: "v1",
        commandId: crypto.randomUUID(),
        commandType: "monitor.rule_create",
        payload: {
          ruleId,
          name: "Quote failure rate",
          sourceId,
          condition: { kind: "compare", metricId: "failure_rate", op: "gt", value: 0.2 },
          debounceSeconds: 0,
          cooldownSeconds: 3600,
        },
        expectedVersion: v.version,
      });
      if (r.status !== 200)
        throw new StepFailure("MONITOR_RULE_FAILED", JSON.stringify(r.json).slice(0, 200));
      const o1 = await k.kernel.monitorScheduler().processEvent({
        sourceId,
        watermark: "2026-10-28T00:00:00.000Z",
        mode: "replay",
        values: { failure_rate: 0.35 },
      });
      return {
        output: { ruleId, outcomes: o1.map((x) => x.outcome) },
        evidence: [{ kind: "monitor-rule", ref: ruleId }],
      };
    },
  );

  // 10. Audit: the capsule is built and independently rebuilt; the engine reruns the headline model
  const capsuleDir = tmp("capsule");
  out.capsuleDir = capsuleDir;
  let auditOk = false;
  await tr.step(
    "audit",
    { ...mockOr("audit", "capsule.verifier", "fixture"), input: { snapshotId, dataHash } },
    async () => {
      if (o.proof) out.proof = await proofStep(o.proof);
      const proofNotes = out.proof ? [out.proof.ui.replace(/BLK-\d+-\d+/g, "the recorded blocker")] : [];
      const bundle = labelledBundle(out, lc);
      out.bundleDir = bundle;
      const manifest = buildCapsule({
        snapshotDir: SNAPSHOT_DIR,
        outDir: capsuleDir,
        researchBundleDir: bundle,
        ...(lc.label === "pre_registered" ? {} : { registrationLabel: lc.label }),
        extraThesisNotes: [...postHocNotes(lc), ...proofNotes, ...(o.extraNotes ?? [])],
      });
      const rep = await verifyCapsule(capsuleDir, { research: "reproduce", wasm: "skip" });
      auditOk = rep.status === "reproduced";
      lc.completeAudit({ ok: auditOk, detail: `capsule ${rep.status}` });
      out.capsuleHash = manifest.capsuleHash;
      // evidence graph: claim <- result <- model <- query <- raw snapshot (hashes carried on every node)
      const gnode = async (kind: string, label: string, data: Record<string, unknown>) => {
        const v = ((await s.owner.call("GET", `/v1/workspaces/${ws}`)).json as { version: number }).version;
        const r = await s.owner.call("POST", `/v1/workspaces/${ws}/graph/nodes`, {
          kind,
          label,
          data,
          expectedVersion: v,
        });
        if (r.status >= 300) throw new StepFailure("GRAPH_NODE_FAILED", JSON.stringify(r.json).slice(0, 200));
        return (r.json as { result: { nodeId: string } }).result.nodeId;
      };
      const gedge = async (from: string, to: string, relation: string) => {
        const v = ((await s.owner.call("GET", `/v1/workspaces/${ws}`)).json as { version: number }).version;
        const r = await s.owner.call("POST", `/v1/workspaces/${ws}/graph/edges`, {
          from,
          to,
          relation,
          expectedVersion: v,
        });
        if (r.status >= 300) throw new StepFailure("GRAPH_EDGE_FAILED", JSON.stringify(r.json).slice(0, 200));
      };
      const art = out.artifact as { preregistration?: { hash?: string }; status?: string };
      const gSource = await gnode("source", `snapshot ${snapshotId}`, { manifestHash: dataHash, snapshotId });
      const canvasNow = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
        panels: Array<{ panelId: string; queryRef: { hash: string; semanticVersion: string } }>;
      };
      const panel0 = canvasNow.panels[0]!;
      const gQuery = await gnode("query", "panel query", {
        panelId: panel0.panelId,
        queryHash: panel0.queryRef.hash,
        semanticVersion: panel0.queryRef.semanticVersion,
      });
      const gModel = await gnode("model", "research model", {
        semanticVersion: "1.0.0",
        modelRevision: art.preregistration?.hash ?? "n/a",
      });
      const gResult = await gnode("statistical_result", `research verdict ${art.status}`, {
        resultId: "research-status",
        capsuleHash: manifest.capsuleHash,
      });
      const gClaim = await gnode("claim", "c-hypothesis", { claimId: "c-hypothesis" });
      await gedge(gResult, gClaim, "supports");
      await gedge(gResult, gModel, "derived_from");
      await gedge(gModel, gQuery, "derived_from");
      await gedge(gQuery, gSource, "derived_from");
      out.graph = { source: gSource, query: gQuery, model: gModel, result: gResult, claim: gClaim };
      if (!auditOk) throw new StepFailure("AUDIT_FAILED", JSON.stringify(rep.failures).slice(0, 300));
      return {
        output: { capsuleHash: manifest.capsuleHash, status: rep.status, checks: rep.checks.length },
        evidence: [{ kind: "capsule", ref: manifest.capsuleHash }],
      };
    },
  );

  // 11. Publish: the lifecycle gate decides; the capsule exports are the published artifacts
  await tr.step(
    "publish",
    {
      component: { id: "publisher.capsule", version: "1" },
      mode: "fixture",
      input: { capsuleHash: out.capsuleHash },
    },
    async () => {
      try {
        const texts: Record<string, string> = {};
        for (const f of ["THESIS.md", "DATA.md", "LIMITATIONS.md"])
          texts[f] = readFileSync(join(capsuleDir, "exports", f), "utf8");
        const d = lc.publish(texts);
        out.publication = { label: d.label, cap: d.evidenceStrengthCap };
        for (const f of ["THESIS.md", "DATA.md", "LIMITATIONS.md"])
          out.texts[f] = readFileSync(join(capsuleDir, "exports", f), "utf8");
        return {
          output: {
            label: d.label,
            files: ["THESIS.md", "DATA.md", "LIMITATIONS.md", "memo.pdf", "site/index.html"],
          },
          evidence: [{ kind: "exports", ref: `${capsuleDir}/exports` }],
        };
      } catch (e) {
        if (e instanceof PublicationBlocked) {
          out.publication = { label: "blocked", blockedReason: e.reason_code };
          throw new StepFailure(e.reason_code, e.message);
        }
        throw e;
      }
    },
  );

  // 12. Commit: a testnet commitment is a signing step the owner has not authorised; nothing is written
  await tr.blocked(
    "commit",
    {
      component: { id: "chain.testnet-commit", version: "1" },
      mode: "fixture",
      input: { capsuleHash: out.capsuleHash },
    },
    "BLOCKED_DEPENDENCY",
    "BLK-20261110-003: no signing or transaction is permitted; the commitment is a human step",
    [{ kind: "blocker", ref: "BLK-20261110-003" }],
  );

  out.trace = tr.trace();
  out.events = lc.events;
  return out;
}

/**
 * The research bundle is published exactly as the engine produced it: the capsule's offline reproduction compares the
 * whole artifact structure, so a bundle with a `registration` section is not reproducible. The registration label and the
 * evidence-strength cap live in the publication layer (THESIS notes, memo, lifecycle decision).
 */
function labelledBundle(out: FlowResult, _lc: ThesisLifecycle): string {
  return out.bundleDir!;
}
const postHocNotes = (lc: ThesisLifecycle): string[] =>
  lc.label === "pre_registered"
    ? []
    : [
        "Registration label: post-hoc registration. The final evaluation ran before the preregistration was frozen, so this result is exploratory and not pre-registered.",
      ];

export const DESCRIPTOR = NEAR_THESIS_DESCRIPTOR;
