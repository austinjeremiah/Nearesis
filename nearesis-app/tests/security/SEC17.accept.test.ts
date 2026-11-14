/**
 * SEC17: an adversarial agent cannot exceed depth, fan-out, tool-call or budget limits by racing, retrying, renaming
 * itself, editing child manifests, nesting, or cancelling and re-creating its parent.
 * Real supervisor, tool-call meter, ledger and Postgres. A sampler records the number of running children at every
 * instant of the attack. The control counts tool calls per parent task instead of per hypothesis.
 */
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { INVESTIGATION_GRANT, ToolCallMeter } from "../../packages/agent-runtime/src/index.ts";
import { auditRows, makeRt, sql } from "../../packages/agent-runtime/test/helpers/rt.ts";

const reasonOf = (e: unknown) => (e as { reasonCode?: string }).reasonCode ?? "THREW";

it("SEC17: racing, retrying, renaming, manifest edits, nesting and parent re-creation never exceed a limit", async () => {
  const rt = await makeRt();
  try {
    const { tenantId, workspaceId, runId, budgetId, sup } = rt;
    const ws = workspaceId;
    const ctx = (
      parent: { taskId: string; depth: number; caps?: string[] },
      task: string,
      hyp = "h-adv",
    ) => ({
      tenantId,
      runId,
      budgetId,
      parent: {
        taskId: parent.taskId,
        depth: parent.depth,
        allowedCapabilities: parent.caps ?? INVESTIGATION_GRANT,
      },
      dedupKey: { workspaceId: ws, investigationId: "inv", task, modelVersion: "m", inputSnapshot: "s" },
      hypothesisId: hyp,
    });
    const req = (n: string, over: Record<string, unknown> = {}) => ({
      role: "director" as const,
      objective: n,
      workspaceId: ws,
      allowedCapabilities: ["agent.spawn@1"],
      maxChildDepth: 10,
      budget: { tokens: 10, toolCalls: 1, usd: 0.1 },
      ...over,
    });
    const root = { taskId: rt.rootTaskId, depth: 0 };

    // sampler: running children and depth at every instant
    let stop = false;
    let maxRunning = 0;
    let maxDepth = 0;
    let samples = 0;
    const sampler = (async () => {
      while (!stop) {
        const r = await sql<{ running: string; d: number | null }>(
          rt,
          `SELECT count(*) FILTER (WHERE depth>=1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL'))::text AS running, max(depth) AS d FROM tasks`,
        );
        maxRunning = Math.max(maxRunning, Number(r[0]!.running));
        maxDepth = Math.max(maxDepth, r[0]!.d ?? 0);
        samples++;
        await new Promise((res) => setTimeout(res, 10));
      }
    })();

    // 1. 50 children at once, then retries after every denial, and renamed identities (a fresh task name each time)
    const burst = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => sup.spawn(req(`c${i}`), ctx(root, `c${i}`))),
    );
    const retries = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => sup.spawn(req(`retry${i}`), ctx(root, `c${i % 50}-renamed-${i}`))),
    );
    const ok1 = [...burst, ...retries].filter((b) => b.status === "fulfilled").length;
    const codes: Record<string, number> = {};
    for (const b of [...burst, ...retries])
      if (b.status === "rejected") codes[reasonOf(b.reason)] = (codes[reasonOf(b.reason)] ?? 0) + 1;

    // 2. manifest edits: a child asking for grants its parent lacks, and for a budget above the workspace budget
    const child = (await sql<{ id: string }>(rt, "SELECT id FROM tasks WHERE depth=1 LIMIT 1"))[0]!.id;
    const grantEdit = await sup
      .spawn(
        req("grant-edit", { allowedCapabilities: ["secrets.export@1", "canvas.patch@1"] }),
        ctx({ taskId: child, depth: 1, caps: ["agent.spawn@1"] }, "grant-edit"),
      )
      .then(() => "accepted", reasonOf);

    // 3. nesting to hide depth: free the cap by finishing the burst children, then chain 1 -> 2 -> 3 -> 4
    await sql(rt, "UPDATE tasks SET status='DONE' WHERE depth>=1");
    const budgetEdit = await sup
      .spawn(
        req("budget-edit", { budget: { tokens: 1e12, toolCalls: 1e9, usd: 1e6 } }),
        ctx(root, "budget-edit"),
      )
      .then(() => "accepted", reasonOf);
    const c1 = await sup.spawn(req("n1"), ctx(root, "n1"));
    const c2 = await sup.spawn(req("n2"), ctx({ taskId: c1.taskId, depth: 1 }, "n2"));
    const c3 = await sup.spawn(req("n3"), ctx({ taskId: c2.taskId, depth: 2 }, "n3"));
    const depth4 = await sup
      .spawn(req("n4"), ctx({ taskId: c3.taskId, depth: 3 }, "n4"))
      .then(() => "accepted", reasonOf);
    const clamp = c1.clampedMaxChildDepth;

    // 4. cancel and re-create the parent: counters belong to the hypothesis, not the task
    const meter = new ToolCallMeter(rt.pool, rt.policy, rt.audit);
    const callAs = (task: string, hyp: string, key: string) =>
      meter
        .consume({
          tenantId,
          workspaceId: ws,
          runId,
          taskId: task,
          hypothesisId: hyp,
          callKey: key,
          tool: "stats.read@1",
        })
        .then((n) => n, reasonOf);
    const parentA = randomUUID();
    const first = await Promise.all(Array.from({ length: 20 }, (_, i) => callAs(parentA, "h-hyp", `a${i}`)));
    await sql(rt, "UPDATE tasks SET lease_revoked=true WHERE id=$1", [rt.rootTaskId]); // cancel the parent
    const parentB = randomUUID(); // re-created parent, same hypothesis
    const second = await Promise.all(Array.from({ length: 10 }, (_, i) => callAs(parentB, "h-hyp", `b${i}`)));
    const accepted = [...first, ...second].filter((x) => typeof x === "number").length;
    const rejectedCalls = [...first, ...second].filter((x) => x === "TOOL_CALL_BUDGET").length;
    const logged = Number(
      (
        await sql<{ n: string }>(rt, "SELECT count(*)::text n FROM tool_call_log WHERE hypothesis_id='h-hyp'")
      )[0]!.n,
    );

    stop = true;
    await sampler;

    // ledger: reserved spend never exceeds the workspace ceiling
    const led = (
      await sql<{ tokens: string; calls: string; usd: string }>(
        rt,
        "SELECT coalesce(sum(tokens),0)::text tokens, coalesce(sum(tool_calls),0)::text calls, coalesce(sum(usd),0)::text usd FROM budget_ledger WHERE kind='reserve'",
      )
    )[0]!;
    const cap = (
      await sql<{ tokens_total: string; tool_calls_total: string; usd_total: string }>(
        rt,
        "SELECT * FROM budgets",
      )
    )[0]!;
    const audits = await auditRows(rt, "kind IN ('spawn.rejected','limit.rejected')");

    // negative control: counting per parent task lets a re-created parent reset the counter
    const perParent = new Map<string, number>();
    const perParentAllowed = (task: string) => {
      const n = (perParent.get(task) ?? 0) + 1;
      perParent.set(task, n);
      return n <= 24;
    };
    let controlTotal = 0;
    for (let i = 0; i < 20; i++) controlTotal += perParentAllowed(parentA) ? 1 : 0;
    for (let i = 0; i < 20; i++) controlTotal += perParentAllowed(parentB) ? 1 : 0;

    expect(maxRunning).toBeLessThanOrEqual(6);
    expect(maxRunning).toBeGreaterThanOrEqual(4); // the cap was actually pressed
    expect(maxDepth).toBeLessThanOrEqual(3);
    expect(ok1).toBe(6);
    expect(codes.FANOUT_LIMIT).toBe(74);
    expect(depth4).toBe("DEPTH_LIMIT");
    expect(clamp).toBe(3);
    expect(accepted).toBe(24);
    expect(rejectedCalls).toBe(6);
    expect(logged).toBe(24);
    expect(grantEdit).toBe("CAPABILITY_ESCALATION");
    expect(budgetEdit).toBe("BUDGET_EXCEEDED");
    expect(Number(led.tokens)).toBeLessThanOrEqual(Number(cap.tokens_total));
    expect(Number(led.calls)).toBeLessThanOrEqual(Number(cap.tool_calls_total));
    expect(Number(led.usd)).toBeLessThanOrEqual(Number(cap.usd_total));
    expect(audits.length).toBeGreaterThanOrEqual(74 + 6 + 3);
    expect(audits.every((a) => a.reason_code)).toBe(true);
    // (b) control: a per-parent counter would have allowed 40 calls (> 24), so the per-hypothesis criterion detects it
    expect(controlTotal).toBe(40);

    observe({
      testId: "SEC17",
      observed: `adversarial agent: 50 simultaneous spawns plus 30 retries/renamed identities -> ${ok1} accepted, ${codes.FANOUT_LIMIT} FANOUT_LIMIT; sampler (${samples} samples) saw at most ${maxRunning} running children and depth ${maxDepth}; child manifest edits denied (grants ${grantEdit}, budget ${budgetEdit}); nested chain refused at depth 4 (${depth4}), maxChildDepth clamped to ${clamp}; parent cancelled and re-created with the same hypothesis: ${accepted} tool calls accepted in total, ${rejectedCalls} rejected (TOOL_CALL_BUDGET), log rows ${logged}; reserved ledger spend ${led.tokens} tokens/${led.calls} calls/${led.usd} usd within the ceiling (${cap.tokens_total}/${cap.tool_calls_total}/${cap.usd_total}); every rejection audited with a reason code (${audits.length} rows); a per-parent counter would have allowed ${controlTotal} calls (control)`,
      fixtureHash: createHash("sha256").update("sec17-adversarial-v1").digest("hex"),
      evidence: {
        maxRunning,
        maxDepth,
        samples,
        codes,
        accepted,
        rejectedCalls,
        logged,
        controlTotal,
        audits: audits.length,
      },
    });
  } finally {
    await rt.stop();
  }
}, 300_000);
