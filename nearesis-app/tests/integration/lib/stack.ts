/**
 * The real local stack for G10: disposable Postgres (kernel + runtime schemas), real kernel with the near-thesis plugin
 * installed under production trust, Temporal worker running the director and role graphs with scripted (mock, labelled)
 * inference, and the real API (apps/api buildApp) over it. No component under test is replaced.
 */
import { randomUUID } from "node:crypto";
import { createRuntimeProvider } from "../../../packages/workflow/src/kernel-deps.ts";
import { ScenarioRoutingProvider } from "./routing-provider.ts";
import {
  makeEnv,
  q,
  startApi,
  startWorker,
  waitFor,
  type Api,
  type Env,
} from "../../../packages/workflow/test/helpers/harness.ts";
import {
  actorFor,
  command as markerCommand,
  type Actor,
} from "../../../packages/workflow/test/acceptance/m-marker-helpers.ts";

export { q, waitFor, markerCommand };
export type { Actor, Api, Env };

export interface Stack {
  env: Env;
  api: Api;
  owner: Actor;
  worker: Awaited<ReturnType<typeof startWorker>>;
  close(): Promise<void>;
}

export async function openStack(o: { liveInference?: boolean } = {}): Promise<Stack> {
  const env = await makeEnv({ kernel: true });
  const api = await startApi(env);
  // liveInference: the worker's live composer uses the real provider (INFERENCE_PROVIDER=openrouter); every question that
  // carries a `[scenario=<name>]` tag (name != none) stays on the scripted rules, so only live questions spend money.
  const worker = await startWorker(
    env,
    o.liveInference ? { live: true, provider: new ScenarioRoutingProvider(createRuntimeProvider()) } : {},
  );
  const k = env.kernel!;
  const owner = actorFor(api.app, "owner", k.userId, await k.kernel.devAuth!.login(k.subject));
  return {
    env,
    api,
    owner,
    worker,
    async close() {
      await worker.stop().catch(() => undefined);
      await api.close().catch(() => undefined);
      await env.stop().catch(() => undefined);
    },
  };
}

export interface AskResult {
  runId: string;
  workflowId: string;
  approvalActionHash?: string;
}
/** POST /questions through the real API with an idempotency key; the scenario tag selects the scripted plan. */
export async function ask(
  s: Stack,
  ws: string,
  scenario: string,
  question = "Are Intents flows economically durable?",
  extra: Record<string, unknown> = {},
): Promise<AskResult> {
  const r = await s.api.call(
    "POST",
    `/v1/workspaces/${ws}/questions`,
    {
      question: `[scenario=${scenario}] ${question}`,
      snapshotPolicy: "pinned",
      budget: { tokens: 200_000, toolCalls: 24, usd: 20 },
      ...extra,
    },
    { "idempotency-key": `idem-${randomUUID()}` },
  );
  if (r.status !== 202) throw new Error(`question rejected: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as unknown as AskResult;
}

export const runRow = async (s: Stack, runId: string) =>
  (
    await q<{ state: string; failure: unknown }>(
      s.env,
      s.env.tenantId,
      "SELECT state, failure FROM runs WHERE id=$1",
      [runId],
    )
  )[0];

export async function waitState(s: Stack, runId: string, states: string[], ms = 120_000): Promise<string> {
  return waitFor(async () => {
    const r = await runRow(s, runId);
    if (r && states.includes(r.state)) return r.state;
    if (r && ["COMPLETE", "FAILED", "CANCELLED", "BLOCKED", "PARTIAL"].includes(r.state))
      throw new Error(`run ${runId} ended ${r.state} while waiting for ${states.join("|")}`);
    return null;
  }, ms);
}

/** Owner decision through the approvals API for the run's pending request. */
export async function approve(s: Stack, runId: string): Promise<string> {
  const pending = await waitFor(async () => {
    const l = await s.api.call("GET", `/v1/runs/${runId}/approvals`);
    return ((l.json.approvals as Array<{ approvalId: string; actionHash: string }> | undefined) ?? [])[0];
  }, 60_000);
  const r = await s.api.call("POST", `/v1/runs/${runId}/approvals/${pending.approvalId}`, {
    decision: "approve",
    actionHash: pending.actionHash,
  });
  if (r.status !== 202) throw new Error(`approval rejected: ${r.status}`);
  return pending.actionHash;
}

export async function waitRunDone(s: Stack, runId: string, workflowId: string) {
  const h = s.env.client.workflow.getHandle(workflowId);
  return h.result() as Promise<{ state: string; childTaskIds: string[]; failure: unknown }>;
}

import { observe } from "@nearesis/acceptance";
import { execReq, giveLease, grant } from "../../../packages/kernel/test/helpers/index.ts";

/**
 * Probes the one live dependency every G10 flow shares: the near-thesis semantic plugin through the kernel gateway.
 * Returns the blocker text when the plugin cannot reach its data layer (BLK-20261111-001: plugin confinement), else null.
 * A blocked dependency is recorded as BLOCKED_DEPENDENCY, never as a pass.
 */
export async function semanticBlocker(s: Stack): Promise<string | null> {
  const k = s.env.kernel!;
  const ws = await k.newWorkspace("probe");
  await giveLease(k.kernel, k.session, ws, "semantic.discover@1", [
    grant({ resource: "semantic", action: "discover" }),
  ]);
  const d = await k.kernel.gateway.invoke(
    k.session.principal,
    execReq(k.session, ws, "semantic.discover@1", {}),
  );
  if (d.state === "ok") return null;
  const msg = JSON.stringify((d as { payload?: unknown }).payload ?? d).slice(0, 200);
  return /egress proxy|PLUGIN_EGRESS/.test(JSON.stringify(d))
    ? `BLK-20261111-001: the near-thesis plugin cannot reach its semantic layer under plugin confinement (${msg})`
    : null;
}

/** Records BLOCKED_DEPENDENCY for `testId` when the shared dependency is down. Returns true when the caller should stop. */
export async function stopIfBlocked(s: Stack, testId: string, what: string): Promise<boolean> {
  const why = await semanticBlocker(s);
  if (!why) return false;
  observe({
    testId,
    observed: `${what} not executed: ${why}. The test body is implemented and runs unchanged once the dependency is restored.`,
    blocked: why,
  });
  return true;
}

/**
 * The scripted composer proposes a panel with a fixed id, and panel ids are unique across an organisation, so a second
 * full flow needs its own organisation. `extraStack` opens one (a fresh database, kernel, worker and API) and registers
 * it for cleanup with `closeExtra`.
 */
const extras: Stack[] = [];
export async function extraStack(): Promise<Stack> {
  const st = await openStack();
  extras.push(st);
  return st;
}
export async function closeExtra(): Promise<void> {
  while (extras.length) await extras.pop()!.close();
}
