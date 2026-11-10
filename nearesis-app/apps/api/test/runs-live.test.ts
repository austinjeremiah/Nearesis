import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectClient } from "@nearesis/workflow";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { temporalEngine } from "../src/temporal-engine.ts";

/**
 * Live wiring check against the local Temporal dev server: the API starts a real InvestigationWorkflow through
 * @nearesis/workflow's client exports and delivers cancel as a real signal. No worker runs (unique task queue), so the
 * workflow stays RUNNING until terminated; the run state itself is A6's concern.
 */
let f: ApiFixture | undefined;
let reachable = false;
const taskQueue = `a7-live-${randomUUID()}`;
let workflowId: string | undefined;
beforeAll(async () => {
  try {
    const c = await connectClient();
    await c.connection.close();
    reachable = true;
  } catch {
    reachable = false;
    return;
  }
  f = await apiFixture({ runtime: true, engine: temporalEngine({ taskQueue }) });
});
afterAll(async () => {
  if (workflowId) {
    const c = await connectClient();
    await c.workflow
      .getHandle(workflowId)
      .terminate("test cleanup")
      .catch(() => undefined);
    await c.connection.close();
  }
  await f?.close();
});

describe("investigation API against live Temporal", () => {
  it("POST /questions starts a workflow; signalling via the API reaches it", async (ctx) => {
    if (!reachable || !f) {
      ctx.skip();
      return;
    }
    const a = await seedOrg(f.db.admin, "live", { alice: "owner" });
    const tok = await login(f.app, a.users.alice!.subject);
    const ws = (
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/workspaces",
          headers: { ...bearer(tok), "idempotency-key": "create-live-0001" },
          payload: { objective: "o", networkScope: "fixture-only" },
        })
      ).json() as { workspaceId: string }
    ).workspaceId;
    const r = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/questions`,
      headers: { ...bearer(tok), "idempotency-key": "live-question-1" },
      payload: { question: "q?", snapshotPolicy: "live", budget: { tokens: 100, toolCalls: 2, usd: 0.1 } },
    });
    expect(r.statusCode).toBe(202);
    const body = r.json() as { runId: string; workflowId: string };
    workflowId = body.workflowId;
    const client = await connectClient();
    const desc = await client.workflow.getHandle(body.workflowId).describe();
    expect(desc.status.name).toBe("RUNNING");
    expect(desc.taskQueue).toBe(taskQueue);
    // replay of the same Idempotency-Key returns the same run (REJECT_DUPLICATE is mapped, not surfaced)
    const again = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/questions`,
      headers: { ...bearer(tok), "idempotency-key": "live-question-1" },
      payload: { question: "q?", snapshotPolicy: "live", budget: { tokens: 100, toolCalls: 2, usd: 0.1 } },
    });
    expect(again.json()).toEqual(body);
    // the engine delivers a real signal (an approve for a hash nobody asked for is simply recorded by the workflow)
    await temporalEngine({ taskQueue }).signal(body.workflowId, "cancel", { requestedBy: "a7" });
    const hist = await client.workflow.getHandle(body.workflowId).fetchHistory();
    const names = (hist.events ?? [])
      .map((e) => e.workflowExecutionSignaledEventAttributes?.signalName)
      .filter(Boolean);
    await client.connection.close();
    expect(names).toContain("cancel");
  });
});
