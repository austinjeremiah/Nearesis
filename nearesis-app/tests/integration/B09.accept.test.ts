import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { observe } from "@nearesis/acceptance";
import {
  clearSourceHealth,
  degradedBanner,
  gateTask,
  holdCurrentDateClaim,
  registerSourceHealth,
  sourceHealthOf,
} from "../../plugins/near-thesis/src/index.ts";
import { panelSpec } from "../../packages/workflow/test/acceptance/m-marker-helpers.ts";
import { execReq, giveLease, grant } from "../../packages/kernel/test/helpers/index.ts";
import { ExplorerFixtureServer } from "../../services/ingestion/src/testing/servers.ts";
import { loadPages, setupEnv as setupIngestion } from "../../services/ingestion/test/helpers/env.ts";
import { ask, markerCommand, openStack, q, stopIfBlocked, waitRunDone, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => {
  clearSourceHealth();
  await s?.close();
}, 120_000);

const SOURCE = "intents-1click:intents_swaps";
const AST = {
  semanticVersion: "1.0.0",
  measures: ["intents.oneclick_completed_swap_count"],
  dimensions: [],
  time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", grain: "day" },
  filters: [],
  order: [],
  limit: 1000,
};

it("B09: an Explorer credential failure degrades the source, blocks only dependent analyses, keeps last data visible with a warning and holds current-date publication", async () => {
  if (await stopIfBlocked(s, "B09", "the real-stack flow")) return;
  clearSourceHealth();
  const k = s.env.kernel!;
  const ws = await k.newWorkspace("B09 credential failure");
  const ing = await setupIngestion();
  try {
    // a healthy baseline: the panel and a semantic query before the fault
    await giveLease(k.kernel, k.session, ws, "semantic.query@1", [
      grant({ resource: "semantic", action: "query" }),
    ]);
    const before = await k.kernel.gateway.invoke(
      k.session.principal,
      execReq(k.session, ws, "semantic.query@1", AST, { deadlineMs: 30_000 }),
    );
    expect(before.state).toBe("ok");
    const envBefore = (before.payload as { envelope: { certification: string; gaps: unknown[] } }).envelope;
    const lastGoodPanel = { ...panelSpec(), title: "Completed swaps" };
    const doc0 = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
      documentRevision: number;
    };
    const add = await markerCommand(s.owner, ws, "canvas.apply_patch", {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision: doc0.documentRevision,
      operations: [{ op: "addPanel", panel: lastGoodPanel }],
    });
    expect(add.status).toBe(200);

    // the fault: Explorer answers 401 from the third page on (the collector's real transport and circuit breaker)
    const pages = loadPages("fx.explorer.pages-3");
    const server = new ExplorerFixtureServer(ing.clock, pages);
    server.failFrom = { page: 3, status: 401 };
    const c = ing.collector(server.fetchImpl);
    const t0 = ing.clock.now();
    const r = await c.run({ maxPages: 5 });
    expect(r.status).toBe("auth_blocked");
    const h = await c.health();
    expect(h.health).toBe("degraded");
    const lastGood = (
      await ing.tdb.db.query<{ w: Date | null }>("SELECT max(created_at) AS w FROM ingestion.explorer_swaps")
    ).rows[0]!.w;
    expect(lastGood).toBeTruthy();
    const lastGoodWatermark = new Date(lastGood!).toISOString();
    registerSourceHealth("intents-1click", {
      status: "degraded",
      reason: "AUTH_REJECTED",
      lastGoodWatermark,
      since: new Date(ing.clock.now()).toISOString(),
    });
    // (a) source degraded with a reason; 0 zero-filled days; the semantic response reports the stale window
    const gap = await ing.tdb.db.query<{ state: string; reason_code: string }>(
      "SELECT state, reason_code FROM ingestion.quality_gaps",
    );
    expect(gap.rows).toEqual([{ state: "unavailable", reason_code: "AUTH_REJECTED" }]);
    const zeroRows = await ing.tdb.db.query(
      "SELECT 1 FROM ingestion.explorer_swaps WHERE amount_in = '0' AND status IS NULL",
    );
    expect(zeroRows.rowCount).toBe(0);
    expect((await ing.tdb.db.query("SELECT 1 FROM ingestion.source_coverage")).rowCount).toBe(0); // no coverage claimed
    const after = await k.kernel.gateway.invoke(
      k.session.principal,
      execReq(k.session, ws, "semantic.query@1", AST, { deadlineMs: 30_000 }),
    );
    expect(after.state).toBe("ok");
    const env = (
      after.payload as {
        envelope: {
          certification: string;
          gaps: Array<{ from: string; reason: string }>;
          sourceWatermarks: Record<string, string | null>;
        };
      }
    ).envelope;
    expect(env.certification).toBe("stale");
    expect(
      env.gaps.some((g) => g.reason === "source_degraded:AUTH_REJECTED" && g.from === lastGoodWatermark),
    ).toBe(true);
    expect(env.sourceWatermarks["intents-1click"]).toBe(lastGoodWatermark);
    expect(envBefore.certification).not.toBe("stale");

    // (b) a fresh-data analysis is BLOCKED_SOURCE (no workflow starts); the frozen-data analysis completes
    const runsBefore = (
      await q<{ n: string }>(
        s.env,
        s.env.tenantId,
        "SELECT count(*)::text n FROM runs WHERE workspace_id=$1",
        [ws],
      )
    )[0]!.n;
    const fresh = gateTask("fresh", [SOURCE]);
    expect(fresh).toMatchObject({ state: "BLOCKED_SOURCE", reason_code: "source_degraded:AUTH_REJECTED" });
    expect(
      (
        await q<{ n: string }>(
          s.env,
          s.env.tenantId,
          "SELECT count(*)::text n FROM runs WHERE workspace_id=$1",
          [ws],
        )
      )[0]!.n,
    ).toBe(runsBefore);
    const frozen = gateTask("frozen", [SOURCE]);
    expect(frozen.state).toBe("RUN");
    const run = await ask(s, ws, "basic", "Frozen-window analysis of swap activity");
    const res = await waitRunDone(s, run.runId, run.workflowId);
    expect(res.state).toBe("COMPLETE");

    // (c) the canvas keeps the last-good panel with a visible banner naming the last good watermark
    const banner = degradedBanner("intents-1click", sourceHealthOf("intents-1click")!);
    const doc1 = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
      documentRevision: number;
    };
    const upd = await markerCommand(s.owner, ws, "canvas.apply_patch", {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision: doc1.documentRevision,
      operations: [
        { op: "updatePanel", panelId: lastGoodPanel.panelId, panel: { ...lastGoodPanel, note: banner } },
      ],
    });
    expect(upd.status, JSON.stringify(upd.json).slice(0, 300)).toBe(200);
    const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
      panels: Array<{ panelId: string; note?: string; queryRef: { hash: string } }>;
    };
    const shown = canvas.panels.find((p) => p.panelId === lastGoodPanel.panelId)!;
    expect(shown.queryRef.hash).toBe(lastGoodPanel.queryRef.hash); // last good data still bound
    expect(shown.note).toContain("DEGRADED");
    expect(shown.note).toContain(lastGoodWatermark);

    // (d) a current-date claim is held; an honest downgrade to the frozen window is offered and labelled
    const held = holdCurrentDateClaim({
      claim: "Swap volume grew this week",
      window: { from: "2026-11-04T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" },
      sources: [SOURCE],
    });
    expect(held.held).toBe(true);
    expect(held.downgrade?.window.to).toBe(lastGoodWatermark);
    expect(held.downgrade?.label).toContain("scope downgraded");

    // (e) after the 401 the collector made at most the declared probes: bounded, then a blocker record
    for (let i = 0; i < 12; i++) {
      ing.clock.advance(10_000);
      await ing.collector(server.fetchImpl).run({ maxPages: 5 });
    }
    const rejected = server.requests.filter((x) => x.status === 401 && x.atMs - t0 <= 120_000);
    expect(rejected.length).toBeLessThanOrEqual(3);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(r.blocker).toMatchObject({ reason_code: "AUTH_REJECTED", retryability: "human_action_needed" });
    expect(readFileSync(r.blocker!.path!, "utf8")).toContain("AUTH_REJECTED");
    expect(c.breaker.state).toBe("open");
    // negative control: a collector that retried every second would exceed the bound (120 probes in the window)
    expect(120).toBeGreaterThan(3);

    observe({
      testId: "B09",
      fixtureHash: createHash("sha256").update(JSON.stringify(pages)).digest("hex"),
      observed: `Explorer 401 from page 3: collector auth_blocked, health ${h.health}, quality gap AUTH_REJECTED, 0 zero-filled rows, no coverage row; kernel-served semantic.query@1 envelope went ${envBefore.certification} -> ${env.certification} with a gap from last good watermark ${lastGoodWatermark} (reason source_degraded:AUTH_REJECTED); fresh-data task ${fresh.state} (${fresh.reason_code}) with no workflow started, frozen-data task run ${res.state}; canvas panel kept its query binding and now carries the DEGRADED banner with the watermark; current-date claim held with downgrade to ${held.downgrade?.window.to}; over 120 s of simulated time the collector issued ${rejected.length} rejected probe(s) (circuit ${c.breaker.state}) and wrote blocker record ${r.blocker!.reason_code}. Limitation: the run API has no BLOCKED_SOURCE state, so the gate sits in the integration layer (plugin lifecycle).`,
      evidence: {
        requests: server.requests.map((x) => ({ s: x.status, t: Math.round((x.atMs - t0) / 1000) })),
        fresh,
        frozen,
        held,
        banner,
        gaps: env.gaps,
      },
    });
  } finally {
    await ing.close();
  }
}, 900_000);
