import { describe, expect, it } from "vitest";
import {
  Dispatcher,
  contextDifferences,
  contextHashes,
  gateTask,
  SnapshotMismatch,
  StepFailure,
  ThesisLifecycle,
  TraceRecorder,
  checkLabels,
  labelFor,
  reconcile,
  scanForbidden,
  validateTrace,
  STEP_NAMES,
} from "../src/index.ts";

const spec = (id = "x.y") => ({ component: { id, version: "1" }, mode: "fixture" as const });
async function fullTrace(over: Partial<Record<(typeof STEP_NAMES)[number], () => Promise<never>>> = {}) {
  const t = new TraceRecorder({ traceId: "t", workspaceId: "w", question: "q", mode: "fixture" });
  for (const n of STEP_NAMES)
    await t.step(n, spec(), over[n] ?? (async () => ({ output: { n }, evidence: [{ kind: "k", ref: n }] })));
  return t.trace();
}

describe("golden trace", () => {
  it("records 12 ordered steps with a continuous hash chain", async () => {
    const tr = await fullTrace();
    expect(validateTrace(tr)).toMatchObject({ ok: true, violations: [] });
    expect(tr.steps.map((s) => s.name)).toEqual([...STEP_NAMES]);
  });
  it("blocks dependents of a failed step and reports the reason", async () => {
    const tr = await fullTrace({
      acquire: async () => {
        throw new StepFailure("AUTH_REJECTED", "401");
      },
    });
    const by = new Map(tr.steps.map((s) => [s.name, s]));
    expect(by.get("acquire")).toMatchObject({ status: "failed", reason_code: "AUTH_REJECTED" });
    expect(by.get("discover")).toMatchObject({ status: "blocked", blockedBy: ["acquire"] });
    expect(validateTrace(tr).violations).toEqual([]);
  });
  it("rejects an undeclared mock, a broken chain and a swallowed failure", async () => {
    const tr = await fullTrace();
    const mock = structuredClone(tr);
    mock.steps[2]!.mode = "mock";
    expect(validateTrace(mock).violations.map((v) => v.rule)).toContain("mock_not_allowed");
    const chain = structuredClone(tr);
    chain.steps[4]!.upstream = "1".repeat(64);
    expect(validateTrace(chain).violations.map((v) => v.rule)).toContain("continuity");
    const sw = structuredClone(tr);
    sw.steps[3]!.status = "failed";
    sw.steps[3]!.reason_code = null;
    expect(validateTrace(sw).violations.map((v) => v.rule)).toContain("swallowed_failure");
  });
});

describe("ordering", () => {
  const owner = { approvedBy: "o", role: "owner" as const };
  const run = (l: ThesisLifecycle, freezeFirst: boolean) => {
    if (freezeFirst) l.freeze("sha256:" + "a".repeat(64), owner);
    l.openLockbox({ evaluationHash: "e" });
    if (!freezeFirst) l.freeze("sha256:" + "a".repeat(64), owner);
    l.completeAudit({ ok: true, detail: "ok" });
  };
  it("pre-registered when the freeze precedes the evaluation", () => {
    const l = new ThesisLifecycle();
    run(l, true);
    expect(l.publish().label).toBe("pre_registered");
    expect(l.orderOf().slice(0, 4)).toEqual([
      "preregistration.frozen",
      "lockbox.opened",
      "audit.completed",
      "research.published",
    ]);
  });
  it("post-hoc when evaluated first, and the label caps the strength", () => {
    const l = new ThesisLifecycle();
    run(l, false);
    const d = l.publish();
    expect(d).toMatchObject({ label: "post-hoc registration", evidenceStrengthCap: "exploratory" });
    expect(d.notes[0]).toContain("post-hoc registration");
  });
  it("refuses a non-owner freeze and blocks publication without one", () => {
    const l = new ThesisLifecycle();
    expect(() => l.freeze("h", { approvedBy: "a", role: "analyst" })).toThrow();
    l.openLockbox({ evaluationHash: "e" });
    l.completeAudit({ ok: true, detail: "" });
    expect(() => l.publish()).toThrow(/owner-approved freeze/);
  });
  it("never writes to a chain", () => {
    const l = new ThesisLifecycle();
    expect(() => l.chain.write("near-mainnet", "commit")).toThrow(/human-only/);
    expect(l.chain.log.every((e) => e.outcome === "refused")).toBe(true);
  });
});

describe("claims", () => {
  it("flags one phrase per forbidden class and passes plain prose", () => {
    const classes = [
      "Verification is complete.",
      "The result is TEE-verified.",
      "We read each user's private transaction history.",
      "The realized spread was small.",
      "This is all NEAR Intents volume.",
      "We swapped real funds.",
    ].map((t) => scanForbidden(t)[0]?.cls);
    expect(new Set(classes).size).toBe(6);
    expect(scanForbidden("A dry quote is not an executed trade; fixture data only.")).toEqual([]);
  });
  it("names the panel that lacks a required label", () => {
    const ok = labelFor(["quote"], "fixture", "2026-11-11");
    expect(checkLabels([{ id: "p1", kinds: ["quote"], text: ok }]).ok).toBe(true);
    expect(
      checkLabels([{ id: "p2", kinds: ["quote"], text: "mode: fixture; date: 2026-11-11" }]).missing,
    ).toEqual([{ id: "p2", missing: ["dry quote, not realized execution", "sampled"] }]);
  });
});

describe("consistency", () => {
  const ctx = { question: "q", snapshotId: "s1", metricVersionMap: { a: "1.0.0" }, preregistrationHash: "p" };
  it("dispatches identical contexts and refuses a different snapshot", () => {
    const d = new Dispatcher(ctx);
    expect(d.dispatch("quant")).toEqual(d.dispatch("skeptic"));
    expect(() => d.dispatch("composer", { snapshotId: "s2" })).toThrow(SnapshotMismatch);
  });
  it("names every field in which a child's context differs from the run's frozen context", () => {
    const run = contextHashes(ctx);
    expect(contextDifferences(run, run)).toEqual([]);
    expect(contextDifferences(run, contextHashes({ ...ctx, question: "other" }))).toEqual(["question"]);
    expect(contextDifferences(run, contextHashes({ ...ctx, preregistrationHash: "q" }))).toEqual([
      "preregistrationHash",
    ]);
    expect(contextDifferences(run, contextHashes({ ...ctx, metricVersionMap: { a: "1.0.1" } }))).toEqual([
      "metricVersionMap",
    ]);
    // a child that carries no context at all differs in all four
    expect(contextDifferences(run, undefined)).toHaveLength(4);
  });
  it("gates fresh-data work on a supplied health lookup, and never gates frozen-data work", () => {
    const bad = (id: string) =>
      id === "near-explorer"
        ? { status: "degraded" as const, reason: "AUTH_REJECTED", lastGoodWatermark: null, since: "t" }
        : undefined;
    expect(gateTask("fresh", ["near-explorer:intents_swaps"], bad)).toMatchObject({
      state: "BLOCKED_SOURCE",
      reason_code: "source_degraded:AUTH_REJECTED",
    });
    expect(gateTask("fresh", ["coingecko:price_candles"], bad).state).toBe("RUN");
    expect(gateTask("frozen", ["near-explorer:intents_swaps"], bad).state).toBe("RUN");
  });
  it("reconciles counts exactly and derived values within tolerance, excluding mismatched snapshots", () => {
    const h = (source: string, value: string, snapshotId = "s1") => ({
      source,
      metric: "m",
      value,
      kind: "count" as const,
      snapshotId,
    });
    expect(reconcile([h("a", "10"), h("b", "10")], "s1").conflicts).toEqual([]);
    expect(reconcile([h("a", "10"), h("b", "11")], "s1").conflicts).toHaveLength(1);
    expect(reconcile([h("a", "10"), h("b", "99", "s2")], "s1").excluded[0]).toMatchObject({
      flag: "snapshot_mismatch",
    });
  });
});
