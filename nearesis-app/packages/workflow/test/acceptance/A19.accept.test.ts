import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { RUN_TRANSITIONS, RunFailure } from "@nearesis/contracts";
import { MISSING_METRIC, groundingScan, hashOf, planFor } from "@nearesis/agent-runtime";
import { makeEnv, q, runViaApi, startApi, startWorker, type Api, type Env } from "../helpers/harness.ts";

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

const corpusPath = fileURLToPath(
  new URL("../../../agent-runtime/test/fixtures/numeric-grounding.json", import.meta.url),
);
const appRoot = fileURLToPath(new URL("../../../..", import.meta.url));

it("A19: the director abstains instead of fabricating and the non-complete run carries the structured failure (question via the API, real kernel gateway and semantic plugin)", async () => {
  // scanner must pass its own corpus before it is applied to A19 output
  const fx = JSON.parse(readFileSync(corpusPath, "utf8"));
  const opts = { intervalBounds: fx.intervalBounds as string[] };
  const missed = fx.unsupported.filter((t: string) => groundingScan(t, fx.facts, opts).clean);
  const falsePos = fx.incidental.filter((t: string) => !groundingScan(t, fx.facts, opts).clean);
  expect(fx.unsupported.length).toBeGreaterThanOrEqual(10);
  expect(fx.incidental.length).toBeGreaterThanOrEqual(10);
  expect(missed).toEqual([]);
  expect(falsePos).toEqual([]);

  const w = await startWorker(env);
  try {
    const run = await runViaApi(env, api, "A19", { question: `What was ${MISSING_METRIC}?` });
    const res = await run.result();
    // (c) PARTIAL/BLOCKED, never COMPLETE; all 5 fields non-empty
    expect(["PARTIAL", "BLOCKED"]).toContain(res.state);
    const failure = RunFailure.parse(res.failure);
    expect(failure.reasonCode).toBe("CANNOT_COMPUTE");
    expect(failure.humanActionNeeded).toBeTruthy();
    expect(failure.lastCheckpoint).toBeTruthy();
    expect(failure.replayCommand).toContain("replay");
    const stored = await q<{ state: string; failure: unknown }>(
      env,
      run.tenantId,
      "SELECT state, failure FROM runs WHERE id=$1",
      [run.runId],
    );
    expect(stored[0]!.state).toBe(res.state);
    expect(RunFailure.parse(stored[0]!.failure)).toEqual(failure);

    // (a) cannot_compute artifact naming the missing metric and the minimal next measurement
    const kids = await q<{
      result: {
        status: string;
        result: {
          finding: { status: string; statement: string; facts: Array<{ value: string; unit: string }> };
          artifact: { missingMetric: string; nextMeasurement: string; label: string };
        };
      };
    }>(env, run.tenantId, "SELECT result FROM tasks WHERE run_id=$1 AND depth=1", [run.runId]);
    expect(kids).toHaveLength(1);
    const analyst = kids[0]!.result.result;
    expect(analyst.finding.status).toBe("cannot_compute");
    expect(analyst.artifact.missingMetric).toBe(MISSING_METRIC);
    expect(analyst.artifact.nextMeasurement.length).toBeGreaterThan(10);
    expect(analyst.finding.statement).toContain(MISSING_METRIC);

    // (b) no further children after abstention; spawn count recorded
    expect(res.spawnCount).toBe(1);
    const spawned = await q<{ role: string }>(
      env,
      run.tenantId,
      "SELECT role FROM tasks WHERE run_id=$1 AND depth>=1",
      [run.runId],
    );
    expect(spawned.map((s) => s.role)).toEqual(["semantic_analyst"]);
    expect(
      (
        await q(env, run.tenantId, "SELECT 1 FROM run_events WHERE run_id=$1 AND kind='director.abstained'", [
          run.runId,
        ])
      ).length,
    ).toBe(1);

    // (d) persisted transitions follow the ch.05 state machine
    const ev = await q<{ from_state: string; to_state: string }>(
      env,
      run.tenantId,
      "SELECT from_state, to_state FROM run_events WHERE run_id=$1 AND kind='transition' ORDER BY seq",
      [run.runId],
    );
    let prev = "REQUESTED";
    for (const e of ev) {
      expect(e.from_state).toBe(prev);
      expect(RUN_TRANSITIONS[e.from_state as keyof typeof RUN_TRANSITIONS]).toContain(e.to_state);
      prev = e.to_state;
    }
    expect(prev).toBe(res.state);

    // (e) numeric grounding of every conclusion (finding statement + narrative fields)
    const texts = [analyst.finding.statement, failure.humanActionNeeded!, analyst.artifact.nextMeasurement];
    const reports = texts.map((t) => ({ text: t, ...groundingScan(t, analyst.finding.facts, opts) }));
    const flagged = reports.flatMap((r) => r.flagged);
    expect(flagged).toEqual([]);
    expect(reports.flatMap((r) => r.supported).length).toBeGreaterThan(0); // the 1,234 figure was actually checked against a tool result

    // replay_command is executable and re-executes the recorded history deterministically
    const t0 = Date.now();
    const cmd = failure.replayCommand.split(" ");
    const replay = spawnSync(cmd[0]!, cmd.slice(1), {
      cwd: appRoot,
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
    });
    expect(replay.status).toBe(0);
    expect(replay.stdout).toContain("REPLAY_OK");

    observe({
      testId: "A19",
      observed: `question via POST /questions, real kernel gateway + near-thesis semantic.discover/query; run ended ${res.state} (not COMPLETE) with reason ${failure.reasonCode}/${failure.retryability}, all 5 failure fields non-empty; analyst returned cannot_compute naming ${MISSING_METRIC} plus next measurement; spawn count ${res.spawnCount} (stage 2 children never spawned); ${ev.length} persisted transitions all legal; numeric scan of ${texts.length} conclusion texts: ${flagged.length} unsupported, ${reports.flatMap((r) => r.supported).length} supported, ${reports.flatMap((r) => r.excluded).length} excluded incidental tokens; scanner corpus ${fx.unsupported.length} unsupported all flagged, ${fx.incidental.length} incidental none flagged; replay_command exit ${replay.status} in ${Date.now() - t0}ms`,
      fixtureHash: hashOf(planFor("A19")),
      evidence: {
        failure,
        transitions: ev,
        spawnCount: res.spawnCount,
        artifact: analyst.artifact,
        numericScan: reports.map((r) => ({
          flagged: r.flagged,
          excluded: r.excluded,
          supported: r.supported,
        })),
        scannerCorpus: {
          unsupported: fx.unsupported.length,
          incidental: fx.incidental.length,
          missed,
          falsePositives: falsePos,
        },
        replay: {
          command: failure.replayCommand,
          exit: replay.status,
          stdoutTail: replay.stdout.trim().slice(-200),
        },
      },
    });
  } finally {
    await w.stop();
  }
}, 300_000);
