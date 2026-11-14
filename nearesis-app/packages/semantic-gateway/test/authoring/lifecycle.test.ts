import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MetricAuthoringError,
  compileProposal,
  executePlan,
  reconcile,
  sampleWindow,
} from "../../src/authoring/index.ts";
import {
  ADMIN,
  AGENT,
  ANALYST,
  OWNER,
  TENANT,
  VIEWER,
  dayOf,
  principal,
  setup,
  txPerDay,
  type Harness,
} from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h.close());

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof MetricAuthoringError ? e.reason : `other:${(e as Error).message}`;
  }
};

describe("compile -> execute -> reconcile on a disposable database", () => {
  it("validates a draft: bounded execution, dedup via FINAL, exact values, raw reconciliation", async () => {
    const r = await h.svc.propose(AGENT, txPerDay(AGENT));
    expect(r.report?.ok).toBe(true);
    expect(r.record.status).toBe("VALIDATED");
    expect(r.record.version).toBe(1);
    const names = r.report?.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "schema_allowlist_units",
        "dependencies_certified",
        "cost_estimate",
        "bounded_execution",
        "reconcile_raw",
      ]),
    );
    expect(r.report?.checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(r.report?.cost?.method).toBe("coverage_rate_x_days");
    expect(r.report?.sampleWindow).toEqual({ from: dayOf(31), to: dayOf(45) });
  });

  it("returns exact values and hides the superseded duplicate version of day 10", async () => {
    const cat = h.catalogue;
    const c = compileProposal(txPerDay(AGENT, { name: "dup_check" }), cat, { tenantId: TENANT });
    if (!c.ok) throw new Error("compile");
    const lim = { maxEstimatedRows: 100000, maxExecutionSeconds: 20, maxRowsToRead: 1_000_000 };
    const s = await executePlan(h.ch, c.plan, { from: dayOf(8), to: dayOf(13) }, lim);
    expect(s.rows.map((r) => [r.bucket, r.value])).toEqual([
      [dayOf(8), "108"],
      [dayOf(9), "109"],
      [dayOf(10), "110"], // not 99999: FINAL keeps the newest version
      [dayOf(11), "111"],
      [dayOf(12), "112"],
    ]);
    const rc = await reconcile(h.ch, c.plan, { from: dayOf(8), to: dayOf(13) }, s, lim);
    expect(rc.ok).toBe(true);
    // a tampered result must fail reconciliation against raw
    s.aggValues.get("tx")?.set(`${dayOf(9)}\u0000`, "1");
    const bad = await reconcile(h.ch, c.plan, { from: dayOf(8), to: dayOf(13) }, s, lim);
    expect(bad.ok).toBe(false);
  });

  it("week grain with a dimension and exact decimals reconciles against raw", async () => {
    const p = txPerDay(AGENT, {
      name: "swap_usd_by_status",
      sources: ["intents_swaps"],
      timeGrain: { column: { table: "intents_swaps", column: "created_day" }, grain: "week" },
      dimensions: [{ table: "intents_swaps", column: "status" }],
      aggregations: [{ id: "usd", fn: "sum", column: { table: "intents_swaps", column: "amount_in_usd" } }],
      unit: "USD",
      precision: { decimals: 2, rounding: "half_even" },
      tests: [{ kind: "reconcile_raw", name: "raw" }],
    });
    const r = await h.svc.propose(AGENT, p);
    expect(r.report?.issues).toEqual([]);
    expect(r.record.status).toBe("VALIDATED");
    const e = await h.svc.explore(
      OWNER,
      { metricKey: "authored.swap_usd_by_status", version: 1 },
      { from: dayOf(6), to: dayOf(34) },
    );
    // 4 whole weeks x 7 days x (10.5 + 20.25) for SUCCESS
    const success = e.envelope.rows.filter((r) => r[1] === "SUCCESS").map((r) => r[2]);
    expect(success).toEqual(["215.25", "215.25", "215.25", "215.25"]);
    const refunded = e.envelope.rows.filter((r) => r[1] === "REFUNDED").map((r) => r[2]);
    expect(refunded).toEqual(["35.00", "35.00", "35.00", "35.00"]);
  });

  it("cross-table ratio is computed per bucket with NULL (never zero) where a side is missing", async () => {
    const p = txPerDay(AGENT, {
      name: "tx_per_swap",
      sources: ["near_daily_tx", "intents_swaps"],
      joins: [
        {
          left: { table: "intents_swaps", column: "created_day" },
          right: { table: "near_daily_tx", column: "block_date" },
        },
      ],
      aggregations: [
        { id: "tx", fn: "sum", column: { table: "near_daily_tx", column: "tx_count" } },
        { id: "sw", fn: "count", column: null, table: "intents_swaps" },
      ],
      formula: { kind: "op", op: "div", left: { kind: "agg", id: "tx" }, right: { kind: "agg", id: "sw" } },
      unit: "tx/row",
      precision: { decimals: 4, rounding: "half_even" },
    });
    const r = await h.svc.propose(AGENT, p);
    expect(r.report?.issues).toEqual([]);
    const e = await h.svc.explore(
      OWNER,
      { metricKey: "authored.tx_per_swap", version: 1 },
      { from: dayOf(0), to: dayOf(3) },
    );
    expect(e.envelope.rows).toEqual([
      [dayOf(0), "33.3333"],
      [dayOf(1), "33.6667"],
      [dayOf(2), "34.0000"],
    ]);
    // coverage honesty: outside the loaded days there are no rows, and a gap day is reported partial / not complete
    const w = await h.svc.explore(
      OWNER,
      { metricKey: "authored.tx_per_swap", version: 1 },
      { from: dayOf(39), to: dayOf(43) },
    );
    expect(w.envelope.rowCoverage).toEqual(["complete", "partial", "partial", "complete"]);
    expect(w.envelope.partialCount).toBe(2);
    expect(w.envelope.gaps.length).toBeGreaterThan(0);
  });

  it("refuses to validate when the cost estimate exceeds the author's cap, or coverage is unknown", async () => {
    const r = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, { name: "too_costly", costEstimate: { maxEstimatedRows: 1 } }),
    );
    expect(r.record.status).toBe("DRAFT");
    expect(r.report?.issues.map((i) => i.reason)).toContain("COST_CAP");
    const q = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, {
        name: "no_coverage",
        sources: ["quote_attempts"],
        timeGrain: { column: { table: "quote_attempts", column: "scheduled_bucket_utc" }, grain: "day" },
        aggregations: [{ id: "n", fn: "count", column: null, table: "quote_attempts" }],
        unit: "row",
      }),
    );
    expect(q.record.status).toBe("DRAFT");
    expect(q.report?.issues.map((i) => i.reason)).toContain("COVERAGE_UNKNOWN");
  });

  it("a failing declared test keeps the metric a DRAFT", async () => {
    const r = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, {
        name: "wrong_expectation",
        tests: [{ kind: "expected_value", name: "day 8", bucket: dayOf(40), value: "1", tolerance: "0" }],
      }),
    );
    expect(r.record.status).toBe("DRAFT");
    expect(r.report?.issues.map((i) => i.reason)).toContain("TEST_FAILED");
  });

  it("compile failures are refused, audited and not stored", async () => {
    expect(await reason(h.svc.propose(AGENT, { ...txPerDay(AGENT), sql: "select 1" }))).toBe(
      "RAW_SQL_REFUSED",
    );
    expect(await reason(h.svc.propose(AGENT, txPerDay(AGENT, { unit: "USD", name: "bad_unit" })))).toBe(
      "UNIT_MISMATCH",
    );
    const trail = await h.store.auditTrail({ tenantId: TENANT, workspaceId: "ws-1" }, "authored.bad_unit");
    expect(trail.map((t) => [t.action, t.outcome])).toEqual([["propose", "refused"]]);
    expect(await h.store.versions({ tenantId: TENANT, workspaceId: "ws-1" }, "authored.bad_unit")).toEqual(
      [],
    );
  });

  it("authorship is taken from the caller, not the body", async () => {
    const spoof = txPerDay(OWNER, { name: "spoofed" });
    expect(await reason(h.svc.propose(AGENT, spoof))).toBe("FORBIDDEN");
  });

  it("sample window picks whole buckets ending at the last covered day", () => {
    expect(sampleWindow("2026-10-15", "day")).toEqual({ from: "2026-10-02", to: "2026-10-16" });
    const w = sampleWindow("2026-10-15", "week"); // Thursday: the partial trailing week is dropped
    expect(w.to).toBe("2026-10-12");
    expect(new Date(`${w.from}T00:00:00Z`).getUTCDay()).toBe(1);
  });
});

describe("lifecycle permissions, audit, immutability, version pinning, publication", () => {
  const scope = { tenantId: TENANT, workspaceId: "ws-1" };
  it("only a human certifier can certify; agents, viewers, analysts, the author and the unvalidated cannot", async () => {
    const draft = await h.svc.propose(AGENT, txPerDay(AGENT, { name: "perm_metric" }));
    expect(draft.record.status).toBe("VALIDATED");
    const v = draft.record.version;
    const k = draft.record.metricKey;
    expect(await reason(h.svc.certify(AGENT, k, v))).toBe("HUMAN_PRINCIPAL_REQUIRED");
    expect(await reason(h.svc.certify(principal("svc", "service", "owner"), k, v))).toBe(
      "HUMAN_PRINCIPAL_REQUIRED",
    );
    expect(await reason(h.svc.certify(ANALYST, k, v))).toBe("CERTIFIER_REQUIRED");
    expect(await reason(h.svc.certify(VIEWER, k, v))).toBe("CERTIFIER_REQUIRED");
    // an unvalidated draft
    const bad = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, { name: "perm_unvalidated", costEstimate: { maxEstimatedRows: 1 } }),
    );
    expect(await reason(h.svc.certify(OWNER, bad.record.metricKey, bad.record.version))).toBe(
      "NOT_VALIDATED",
    );
    // a human author cannot self-certify
    const own = await h.svc.propose(ANALYST, txPerDay(ANALYST, { name: "perm_self" }));
    expect(own.record.status).toBe("VALIDATED");
    const humanOwnerAuthor = principal("owner-2", "human", "owner");
    const ownerDraft = await h.svc.propose(
      humanOwnerAuthor,
      txPerDay(humanOwnerAuthor, { name: "perm_owner_self" }),
    );
    expect(
      await reason(h.svc.certify(humanOwnerAuthor, ownerDraft.record.metricKey, ownerDraft.record.version)),
    ).toBe("SELF_CERTIFICATION_REFUSED");
    // viewers cannot propose
    expect(await reason(h.svc.propose(VIEWER, txPerDay(VIEWER, { name: "perm_viewer" })))).toBe("FORBIDDEN");
    // refusals are audited
    const trail = await h.store.auditTrail(scope, k);
    expect(trail.filter((t) => t.outcome === "refused").map((t) => t.actorKind)).toEqual([
      "agent",
      "service",
      "human",
      "human",
    ]);
    // the certifier succeeds
    const done = await h.svc.certify(OWNER, k, v);
    expect(done.status).toBe("CERTIFIED");
    expect(done.certifiedBy).toBe(OWNER.id);
    const after = await h.store.auditTrail(scope, k);
    expect(after.at(-1)).toMatchObject({
      action: "certify",
      outcome: "ok",
      actorId: OWNER.id,
      actorKind: "human",
      actorRole: "owner",
    });
  });

  it("a stale validation cannot be certified", async () => {
    const d = await h.svc.propose(AGENT, txPerDay(AGENT, { name: "stale_one" }));
    h.now.t = new Date(h.now.t.getTime() + 8 * 86_400_000);
    expect(await reason(h.svc.certify(ADMIN, d.record.metricKey, d.record.version))).toBe("STALE_VALIDATION");
    h.now.t = new Date(h.now.t.getTime() - 8 * 86_400_000);
  });

  it("a certified version is immutable at the database level; a definition change makes a new version", async () => {
    const k = "authored.perm_metric";
    await expect(
      h.pool.query(
        "UPDATE analytics_meta.authored_metrics SET proposal = '{}'::jsonb WHERE metric_key = $1",
        [k],
      ),
    ).rejects.toThrow(/IMMUTABLE_VERSION/);
    await expect(
      h.pool.query("DELETE FROM analytics_meta.authored_metrics WHERE metric_key = $1", [k]),
    ).rejects.toThrow(/IMMUTABLE_VERSION/);
    await expect(
      h.pool.query("UPDATE analytics_meta.authored_metric_audit SET action = 'x'"),
    ).rejects.toThrow(/APPEND_ONLY/);
    expect(await reason(h.svc.edit(ANALYST, k, 1, txPerDay(ANALYST, { name: "perm_metric" })))).toBe(
      "IMMUTABLE_VERSION",
    );
    expect(await reason(h.svc.validate(AGENT, k, 1))).toBe("ILLEGAL_TRANSITION");

    const before = (await h.svc.get(OWNER, k, 1)).proposalHash;
    const rev = await h.svc.revise(
      AGENT,
      k,
      1,
      txPerDay(AGENT, { name: "perm_metric", precision: { decimals: 2, rounding: "half_even" } }),
    );
    expect(rev.record.version).toBe(2);
    expect(rev.record.status).toBe("VALIDATED");
    expect((await h.svc.get(OWNER, k, 1)).proposalHash).toBe(before);
    expect((await h.svc.get(OWNER, k, 1)).proposal.precision.decimals).toBe(0);
  });

  it("snapshots pin versions; a new certified version or a deprecation never rewrites them; V18 correction invalidates dependents", async () => {
    const k = "authored.perm_metric";
    const pins = await h.svc.pinSnapshot(OWNER, "snap-1", [{ metricKey: k, version: 1 }]);
    expect(pins).toEqual([
      { metricKey: k, version: 1, proposalHash: (await h.svc.get(OWNER, k, 1)).proposalHash },
    ]);
    // an uncertified version cannot be pinned
    expect(await reason(h.svc.pinSnapshot(OWNER, "snap-2", [{ metricKey: k, version: 2 }]))).toBe(
      "METRIC_NOT_CERTIFIED",
    );

    // certify v2 (a different human certifier than the agent author) and the pin of snap-1 is unchanged
    await h.svc.certify(ADMIN, k, 2);
    expect((await h.store.get(scope, k, 1))?.supersededBy).toBe(2);
    expect(await h.svc.pinsOf(OWNER, "snap-1")).toEqual(pins);
    await expect(h.pool.query("UPDATE analytics_meta.authored_metric_pins SET version = 2")).rejects.toThrow(
      /APPEND_ONLY/,
    );

    // a metric that depends on v1 is invalidated by the correction too
    const dep = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, { name: "depends_on_v1", dependencies: [`${k}@1`] }),
    );
    expect(dep.report?.ok).toBe(true);

    expect(await reason(h.svc.deprecate(AGENT, k, 1, "wrong definition found"))).toBe(
      "HUMAN_PRINCIPAL_REQUIRED",
    );
    expect(await reason(h.svc.deprecate(ANALYST, k, 1, "wrong definition found"))).toBe("CERTIFIER_REQUIRED");
    const out = await h.svc.deprecate(OWNER, k, 1, "definition double counted retried transactions", {
      correction: true,
    });
    expect(out.record.status).toBe("DEPRECATED");
    expect(out.invalidated.snapshots).toEqual(["snap-1"]);
    expect(out.invalidated.metrics).toEqual([{ metricKey: "authored.depends_on_v1", version: 1 }]);
    const hist = await h.svc.versions(OWNER, k);
    expect(hist.corrections.map((c) => [c.dependentKind, c.dependentId])).toEqual([
      ["snapshot", "snap-1"],
      ["metric", "authored.depends_on_v1@1"],
    ]);
    expect(hist.versions.map((v) => [v.version, v.status])).toEqual([
      [1, "DEPRECATED"],
      [2, "CERTIFIED"],
    ]);
    // the pin and the old definition are intact: history is not rewritten
    expect(await h.svc.pinsOf(OWNER, "snap-1")).toEqual(pins);
    expect((await h.svc.get(OWNER, k, 1)).proposal.precision.decimals).toBe(0);
    expect(hist.audit.map((a) => a.action)).toContain("deprecate");
    // a deprecated version cannot be re-deprecated, and cannot be depended upon
    expect(await reason(h.svc.deprecate(OWNER, k, 1, "again and again"))).toBe("ILLEGAL_TRANSITION");
    const dep2 = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, { name: "depends_on_dead", dependencies: [`${k}@1`] }),
    );
    expect(dep2.report?.issues.map((i) => i.reason)).toContain("DEPENDENCY_NOT_CERTIFIED");
  });

  it("exploration labels draft and validated results; certified results carry no stamp; viewers cannot explore drafts", async () => {
    const d = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, { name: "explore_me", costEstimate: { maxEstimatedRows: 1 } }),
    );
    expect(d.record.status).toBe("DRAFT");
    // a draft cannot execute under a cost cap of 1 row (same gate as validation)
    expect(await reason(h.svc.explore(ANALYST, { metricKey: d.record.metricKey, version: 1 }))).toBe(
      "COST_CAP",
    );
    const v = await h.svc.propose(AGENT, txPerDay(AGENT, { name: "explore_ok" }));
    const ev = await h.svc.explore(ANALYST, { metricKey: v.record.metricKey, version: 1 });
    expect(ev.envelope.metricStatus).toBe("validated");
    expect(ev.envelope.exploratory?.banner).toMatch(/EXPLORATORY/);
    expect(ev.envelope.exploratory?.metricVersion).toBe(1);
    expect(ev.envelope.certification).toBe("experimental");
    expect(await reason(h.svc.explore(VIEWER, { metricKey: v.record.metricKey, version: 1 }))).toBe(
      "EXPLORATION_NOT_PERMITTED",
    );
    const cert = await h.svc.explore(ANALYST, { metricKey: "authored.perm_metric" });
    expect(cert.envelope.certification).toBe("certified");
    expect(cert.envelope.metricStatus).toBeUndefined();
    expect(cert.envelope.exploratory).toBeUndefined();
    expect(cert.record.version).toBe(2);
    // the explored draft is a labelled DRAFT too
    const dr = await h.svc.propose(
      AGENT,
      txPerDay(AGENT, { name: "explore_draft", tests: [{ kind: "min_rows", name: "many", rows: 99 }] }),
    );
    expect(dr.record.status).toBe("DRAFT");
    const de = await h.svc.explore(AGENT, { metricKey: dr.record.metricKey, version: 1 });
    expect(de.envelope.metricStatus).toBe("draft");
  });

  it("the publication path refuses every non-certified metric and accepts certified ones", async () => {
    expect(
      await reason(h.svc.assertPublishable(OWNER, [{ metricKey: "authored.explore_ok", version: 1 }])),
    ).toBe("METRIC_NOT_CERTIFIED"); // VALIDATED
    expect(
      await reason(h.svc.assertPublishable(OWNER, [{ metricKey: "authored.explore_draft", version: 1 }])),
    ).toBe("METRIC_NOT_CERTIFIED"); // DRAFT
    expect(
      await reason(h.svc.assertPublishable(OWNER, [{ metricKey: "authored.perm_metric", version: 1 }])),
    ).toBe("METRIC_NOT_CERTIFIED"); // DEPRECATED
    expect(await reason(h.svc.assertPublishable(OWNER, [{ metricKey: "authored.nonexistent" }]))).toBe(
      "METRIC_NOT_CERTIFIED",
    );
    await expect(
      h.svc.assertPublishable(OWNER, [{ metricKey: "authored.perm_metric", version: 2 }]),
    ).resolves.toBeUndefined();
    await expect(
      h.svc.assertPublishable(OWNER, [{ metricKey: "authored.perm_metric" }]),
    ).resolves.toBeUndefined();
    try {
      await h.svc.assertPublishable(OWNER, [
        { metricKey: "authored.explore_ok", version: 1 },
        { metricKey: "authored.perm_metric", version: 2 },
      ]);
    } catch (e) {
      expect((e as MetricAuthoringError).issues.map((i) => i.path)).toEqual(["authored.explore_ok"]);
    }
  });

  it("tenants and workspaces are isolated", async () => {
    const other = principal("owner-x", "human", "owner", "tenant-b");
    expect(await reason(h.svc.get(other, "authored.perm_metric", 2))).toBe("NOT_FOUND");
    expect((await h.svc.catalogue(other)).filter((c) => c.source === "authored")).toEqual([]);
    const cat = await h.svc.catalogue(OWNER);
    const row = cat.find((c) => c.metricKey === "authored.perm_metric");
    expect(row).toMatchObject({ status: "CERTIFIED", version: 2, exploratory: false });
    expect(cat.find((c) => c.metricKey === "authored.explore_ok")).toMatchObject({
      status: "VALIDATED",
      exploratory: true,
    });
  });
});
