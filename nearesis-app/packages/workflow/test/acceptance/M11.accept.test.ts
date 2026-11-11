import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  MISSING_METRIC,
  PRIMARY_METRIC,
  SEMANTIC_VERSION,
  child,
  hashOf,
  planFor,
  primaryQuery,
  tag,
  type ScriptRule,
} from "@nearesis/agent-runtime";
import { makeEnv, q, startApi, waitFor, type Api, type Env } from "../helpers/harness.ts";
import {
  actorFor,
  addPanel,
  command,
  createMarker,
  selectionFor,
  sha256,
  startScriptedWorker,
  type Actor,
} from "./m-marker-helpers.ts";

let env: Env;
let api: Api;
beforeAll(async () => {
  env = await makeEnv({ kernel: true });
  api = await startApi(env);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await env.stop();
});
const ws = () => env.workspaceId;

// fx.agent.skeptic-scripted: scripted model responses (labelled unattested_dev). One valid script (stock `basic`), one whose
// conclusion states a number no tool result contains, one that asks for a metric that is not in the catalog (stock `A19`).
const INVENTED = "M11-invented";
const prompts: string[] = [];
const rules: ScriptRule[] = [
  { match: (r) => (prompts.push(r.prompt), false), respond: () => ({}) }, // recorder: every prompt, in order
  {
    match: (r) =>
      r.prompt.includes("[role=director]") &&
      r.prompt.includes("[phase=plan]") &&
      r.prompt.includes(tag(INVENTED)),
    respond: () => ({
      ...planFor("basic"),
      stages: [[child(INVENTED, "semantic_analyst", "measure swap activity")]],
    }),
  },
  {
    match: (r) =>
      r.prompt.includes(tag(INVENTED)) &&
      r.prompt.includes("[role=semantic_analyst]") &&
      r.prompt.includes("[step=0]"),
    respond: () => ({ action: "tool", tool: "semantic.discover@1", input: {} }),
  },
  {
    match: (r) =>
      r.prompt.includes(tag(INVENTED)) &&
      r.prompt.includes("[role=semantic_analyst]") &&
      r.prompt.includes("[step=1]"),
    respond: () => ({ action: "tool", tool: "semantic.query@1", input: primaryQuery() }),
  },
  {
    match: (r) =>
      r.prompt.includes(tag(INVENTED)) &&
      r.prompt.includes("[role=semantic_analyst]") &&
      r.prompt.includes("[step=2]"),
    respond: (r) => {
      const m = /step 1 semantic\.query@1 -> <untrusted_data[^>]*>\n([\s\S]*?)\n<\/untrusted_data>/.exec(
        r.prompt,
      );
      const env_ = (
        JSON.parse(m![1]!) as {
          envelope: { columns: Array<{ name: string }>; rows: Array<Array<string | number | null>> };
        }
      ).envelope;
      const col = env_.columns.findIndex((c) => c.name !== "intents.day");
      const peak = Math.max(...env_.rows.map((x) => Number(x[col])));
      return {
        action: "finish",
        status: "supported",
        // the peak is real, "48213" appears in no tool result
        statement: `Completed swaps peaked at ${peak} per day and reached 48213 on the anomaly day.`,
        facts: [{ value: String(peak), unit: "swaps", sourceStep: 1, column: env_.columns[col]!.name }],
        limitations: ["scripted invented number"],
      };
    },
  },
];

type MarkerView = { status: string; reasonCode: string | null; linkedEvidenceIds: string[] };

it("M11: the subagent receives the exact selection and only validated evidence is linked to the marker; an invented number and an unknown metric are refused", async () => {
  const kenv = env.kernel!;
  const owner = actorFor(api.app, "owner", kenv.userId, await kenv.kernel.devAuth!.login(kenv.subject));
  const panel = await addPanel(owner, ws());
  const sel = selectionFor();
  const w = await startScriptedWorker(env, rules);
  try {
    const dispatchUntil = async (markerId: string, done: (m: MarkerView) => boolean) =>
      waitFor(
        async () => {
          await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
          const m = (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}`))
            .json as unknown as MarkerView;
          return done(m) ? m : null;
        },
        150_000,
        500,
      );
    const assign = async (scenario: string) => {
      const markerId = await createMarker(
        owner,
        ws(),
        panel.panelId,
        `[scenario=${scenario}] What drove the move in this interval?`,
      );
      const a = await command(owner, ws(), "marker.assign", { markerId, agents: ["skeptic"] });
      expect(a.status).toBe(200);
      return markerId;
    };
    const taskOf = async (markerId: string) =>
      (
        (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${markerId}/tasks`)).json as {
          tasks: Array<{ runId: string; status: string; reasonCode: string | null }>;
        }
      ).tasks[0]!;
    const evidenceFor = async (markerId: string) =>
      (
        await kenv.kernelAdmin.query(
          "SELECT id, data FROM evidence_nodes WHERE workspace_id=$1 AND data->>'markerId'=$2",
          [ws(), markerId],
        )
      ).rows as Array<{
        id: string;
        data: { agentTaskId: string; outputRef: string; runId: string; markerId: string };
      }>;
    const childCount = async (runId: string) =>
      Number(
        (
          await q<{ n: string }>(
            env,
            env.tenantId,
            "SELECT count(*)::text n FROM tasks WHERE run_id=$1 AND depth>0",
            [runId],
          )
        )[0]!.n,
      );

    // ---- valid script
    const before = prompts.length;
    const okMarker = await assign("basic");
    const ok = await dispatchUntil(okMarker, (m) => m.status === "REVIEW_REQUIRED");
    const okTask = await taskOf(okMarker);
    expect(okTask.status).toBe("COMPLETE");
    // (a) the agent's first input context equals the stored selection and carries no image
    const first = prompts.slice(before).find((p) => p.includes(okMarker))!;
    expect(first, "the director's first prompt carries the marker context").toBeTruthy();
    const m = /Selection: (\{.*?\})\. /.exec(first);
    expect(m, "structured selection in the agent input").toBeTruthy();
    const received = JSON.parse(m![1]!) as typeof sel;
    expect(received).toEqual(sel); // queryHash, semanticVersion, interval, seriesIds, units, sourceWatermark, byte for byte
    expect(received.queryHash).toBe(sel.queryHash);
    expect(first).not.toMatch(/data:image|base64,|\.png|\.jpe?g|\.webp|pixel/i);
    // (b) validated evidence: every number resolves to a result row, metric references are in the catalog at the version
    const ev = await evidenceFor(okMarker);
    expect(ev.length).toBeGreaterThan(0);
    expect(ok.linkedEvidenceIds.sort()).toEqual(ev.map((e) => e.id).sort());
    expect(sel.semanticVersion).toBe(SEMANTIC_VERSION);
    const validation: Array<{
      evidenceId: string;
      role: string;
      numbers: string[];
      unresolved: string[];
      metrics: string[];
    }> = [];
    for (const e of ev) {
      const t = (
        await q<{
          role: string;
          result: {
            result: {
              toolLog: Array<{ ok: boolean; output?: unknown; observation?: unknown }>;
              facts?: Array<{ value: string; column: string }>;
              statement?: string;
            };
          } | null;
          output_ref: string | null;
        }>(env, env.tenantId, "SELECT role, result, output_ref FROM tasks WHERE id=$1 AND workspace_id=$2", [
          e.data.agentTaskId,
          ws(),
        ])
      )[0]!;
      expect(t.output_ref).toBe(e.data.outputRef);
      const art = t.result!.result as {
        statement?: string;
        facts?: Array<{ value: string; column: string }>;
        toolLog: unknown[];
      };
      const corpus = JSON.stringify(art.toolLog);
      const nums = [...(art.statement ?? "").matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)].map((x) => x[0]);
      const unresolved = nums.filter((n) => !corpus.includes(n));
      const metrics = (art.facts ?? []).map((f) => f.column).filter((c) => c !== "intents.day");
      expect(unresolved, `numbers in ${t.role} artifact not found in any tool result`).toEqual([]);
      for (const c of metrics)
        expect(
          [PRIMARY_METRIC, "r2"].includes(c) || c.startsWith("intents.") || c === "r2",
          `metric ${c}`,
        ).toBe(true);
      validation.push({ evidenceId: e.id, role: t.role, numbers: nums, unresolved, metrics });
    }
    // (e) trace: marker -> task -> run -> child tasks in this workspace with tool-call envelopes
    const kids = await q<{
      id: string;
      workspace_id: string;
      result: { result: { parentRunId: string; toolLog: unknown[] } };
    }>(
      env,
      env.tenantId,
      "SELECT id, workspace_id, result FROM tasks WHERE run_id=$1 AND depth>0 AND output_ref IS NOT NULL",
      [okTask.runId],
    );
    expect(kids.length).toBeGreaterThan(0);
    for (const k_ of kids) {
      expect(k_.workspace_id).toBe(ws());
      expect(k_.result.result.parentRunId).toBe(okTask.runId);
      expect(k_.result.result.toolLog.length).toBeGreaterThan(0);
    }
    expect(ev.every((e) => e.data.markerId === okMarker && e.data.runId === okTask.runId)).toBe(true);

    // ---- invented number
    const inv = await assign(INVENTED);
    const invMarker = await dispatchUntil(
      inv,
      (mm) => mm.reasonCode !== null || mm.status === "REVIEW_REQUIRED",
    );
    const invTask = await taskOf(inv);
    // (c) refused: nothing linked, visible failure, marker not advanced to review
    expect(invMarker.status).not.toBe("REVIEW_REQUIRED");
    expect(invMarker.reasonCode).toBeTruthy();
    expect(invMarker.linkedEvidenceIds).toEqual([]);
    expect(await evidenceFor(inv)).toEqual([]);
    expect(invTask.status).toBe("FAILED");
    const invRun = await q<{ state: string; failure: { reasonCode?: string } | null }>(
      env,
      env.tenantId,
      "SELECT state, failure FROM runs WHERE id=$1",
      [invTask.runId],
    );
    const invFailed = await q<{
      role: string;
      status: string;
      result: unknown;
      output_ref: string | null;
      failure_reason: string | null;
    }>(
      env,
      env.tenantId,
      "SELECT role, status, result, output_ref, (result->>'reasonCode') AS failure_reason FROM tasks WHERE run_id=$1 AND depth>0",
      [invTask.runId],
    );
    // the runtime itself refused the artifact: the child failed UNGROUNDED_NUMBER and produced no finding
    expect(invFailed).toHaveLength(1);
    expect(invFailed[0]).toMatchObject({ role: "semantic_analyst", failure_reason: "UNGROUNDED_NUMBER" });
    expect((invFailed[0]!.result as { result: { finding: unknown; status: string } }).result).toMatchObject({
      finding: null,
      status: "failed",
    });

    // ---- unknown metric (stock A19 abstention)
    const unk = await assign("A19");
    const unkMarker = await dispatchUntil(
      unk,
      (mm) => mm.reasonCode !== null || mm.status === "REVIEW_REQUIRED",
    );
    const unkTask = await taskOf(unk);
    // (d) same refusal; no further spawn after the abstention
    expect(unkMarker.status).not.toBe("REVIEW_REQUIRED");
    expect(unkMarker.reasonCode).toBeTruthy();
    expect(unkMarker.linkedEvidenceIds).toEqual([]);
    expect(await evidenceFor(unk)).toEqual([]);
    expect(unkTask.status).toBe("FAILED");
    expect(await childCount(unkTask.runId)).toBe(1); // only the semantic analyst; quant and skeptic were never spawned
    void MISSING_METRIC;

    observe({
      testId: "M11",
      observed: `Valid script: the director's first prompt carried the structured selection byte-equal to the stored one (queryHash ${sel.queryHash.slice(0, 12)}..., semanticVersion ${sel.semanticVersion}, interval, seriesIds, units, sourceWatermark) and no image data; the run completed, marker REVIEW_REQUIRED with ${ev.length} linked evidence nodes whose artifact numbers all resolve to tool-result rows (0 unresolved) and whose metrics are in the catalog at ${SEMANTIC_VERSION}; trace links marker, task, run, ${kids.length} child tasks in the workspace with tool-call envelopes. Invented-number script (48213 in no result): the role graph rejected it (UNGROUNDED_NUMBER path), task FAILED with reason_code ${invMarker.reasonCode}, 0 evidence linked, marker ${invMarker.status}. Unknown-metric script (A19): task FAILED with reason_code ${unkMarker.reasonCode}, 0 evidence linked, ${await childCount(unkTask.runId)} child spawned, marker ${unkMarker.status}`,
      fixtureHash: hashOf({ valid: planFor("basic"), invented: INVENTED, unknown: planFor("A19") }),
      evidence: {
        selection: sel,
        validation,
        invented: {
          markerStatus: invMarker.status,
          reasonCode: invMarker.reasonCode,
          runState: invRun[0]?.state,
          runFailure: invRun[0]?.failure ?? null,
          childFailures: invFailed.map((t) => ({ role: t.role, status: t.status })),
        },
        unknownMetric: {
          markerStatus: unkMarker.status,
          reasonCode: unkMarker.reasonCode,
          children: await childCount(unkTask.runId),
        },
        engine:
          "real Temporal worker with the deterministic ScriptedProvider (unattested_dev), not a live model",
        configHash: sha256({ rules: rules.length }),
      },
    });
  } finally {
    await w.stop();
  }
}, 600_000);
