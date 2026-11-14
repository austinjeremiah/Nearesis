import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  RegistryError,
  activeRegistry,
  applyChange,
  attachDiff,
  approveChange,
  baseline,
  canonicalJson,
  createPg,
  diffChange,
  generateMetricsMd,
  migratePg,
  proposeChange,
  requestPromotion,
  sealRegistry,
  sha256,
  verificationLabel,
  type ChangeProposal,
  type DiffReport,
} from "../../src/index.ts";
import { setupEnv, type Env } from "../helpers.ts";

let env: Env;
const pool = createPg();
const cleanup = () =>
  pool.query("DELETE FROM analytics_meta.metric_promotions WHERE proposed_by LIKE 'acc-%'");
beforeAll(async () => {
  env = await setupEnv(baseline());
  await migratePg(pool);
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await pool.end();
  await env.close();
});

const METRIC = "near.distinct_signer_proxy";
const change: ChangeProposal = {
  metricId: METRIC,
  patch: {
    transformations: [
      "Daily distinct signers; days below 500 successful transactions are excluded as low-activity",
    ],
  },
  evaluator: {
    table: "near_daily_usage",
    dayColumn: "block_date",
    agg: "sum",
    column: "distinct_signer_proxy",
    filters: [{ column: "successful_tx_count", op: "gte", value: 500 }],
  },
};

test("S12 certified metric change needs a dataset-backed diff and approval; experimental promotion is refused", async () => {
  const base = env.registry;
  const N = base.semanticVersion;

  // 1. unapproved change is inactive
  const id = await proposeChange(pool, base, change, "acc-proposer");
  const active0 = await activeRegistry(pool, base);
  expect(active0.semanticVersion).toBe(N);
  expect(active0.contentHash).toBe(base.contentHash);
  await expect(approveChange(pool, base, id, "acc-reviewer")).rejects.toMatchObject({
    reason: "DIFF_REQUIRED",
  });

  // 2. dataset-backed diff
  const report: DiffReport = await diffChange(
    env.ch,
    base,
    change,
    { from: "2026-10-01", to: "2026-10-10" },
    {
      panels: { [METRIC]: ["panel:signers-trend"] },
      claims: { [METRIC]: ["claim:signers-grew"] },
    },
  );
  for (const k of [
    "old",
    "new",
    "columnChanges",
    "resultColumns",
    "dependentPanels",
    "dependentClaims",
    "statisticalOutputChange",
    "oldHash",
    "newHash",
  ] as const)
    expect(report[k], k).toBeDefined();
  for (const side of [report.old, report.new])
    for (const k of ["mean", "nullDays", "coverageCompleteDays", "days"] as const)
      expect(side[k], k).not.toBeUndefined();
  expect(report.old.mean).toBeCloseTo(15.5, 9); // sum(11..20)/10
  expect(report.new.nullDays).toBeGreaterThan(report.old.nullDays); // low-activity days now excluded
  expect(report.new.mean).not.toBe(report.old.mean);
  expect(report.columnChanges.map((c) => c.field).sort()).toEqual(["evaluator", "transformations"]);
  expect(report.dependentPanels).toEqual(["panel:signers-trend"]);
  expect(report.dependentClaims).toEqual(["claim:signers-grew"]);
  const diffHash = await attachDiff(pool, id, report);

  // 3. self-approval refused, reviewer approval activates N+1
  await expect(approveChange(pool, base, id, "acc-proposer")).rejects.toMatchObject({
    reason: "SELF_APPROVAL_REFUSED",
  });
  const next = await approveChange(pool, base, id, "acc-reviewer");
  const active1 = await activeRegistry(pool, base);
  expect(active1.semanticVersion).not.toBe(N);
  expect(active1.semanticVersion).toBe("1.1.0");
  expect(active1.contentHash).not.toBe(base.contentHash);
  expect(active1.contentHash).toBe(next.contentHash);
  const row = (
    await pool.query(
      "SELECT status, approver, diff_hash, from_hash, to_hash, to_version FROM analytics_meta.metric_promotions WHERE id = $1",
      [id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    status: "approved",
    approver: "acc-reviewer",
    diff_hash: diffHash,
    from_hash: base.contentHash,
    to_hash: next.contentHash,
    to_version: "1.1.0",
  });

  // 4. experimental metric promotion without review is rejected, and it is labelled unverified
  const exp = sealRegistry({
    ...next,
    metrics: [
      ...next.metrics,
      {
        ...next.metrics.find((m) => m.id === "intents.oneclick_total_swap_count")!,
        id: "exp.custom_ratio",
        displayName: "Custom ratio (workspace experiment)",
        certified: false,
      },
    ],
  });
  const m = exp.metrics.find((x) => x.id === "exp.custom_ratio")!;
  expect(verificationLabel(m)).toBe("unverified");
  await expect(requestPromotion(pool, exp, "exp.custom_ratio", "acc-proposer")).rejects.toBeInstanceOf(
    RegistryError,
  );
  await expect(requestPromotion(pool, exp, "exp.custom_ratio", "acc-proposer")).rejects.toMatchObject({
    reason: "EXPERIMENTAL_PROMOTION_REFUSED",
  });
  const refused = await pool.query(
    "SELECT status, reason_code FROM analytics_meta.metric_promotions WHERE metric_id = 'exp.custom_ratio' AND proposed_by = 'acc-proposer'",
  );
  expect(refused.rows[0]).toMatchObject({
    status: "rejected",
    reason_code: "EXPERIMENTAL_PROMOTION_REFUSED",
  });
  expect(exp.metrics.find((x) => x.id === "exp.custom_ratio")!.certified).toBe(false);

  // 5. METRICS.md deterministic and shows only the intended change
  const mdN = generateMetricsMd(base);
  expect(generateMetricsMd(base)).toBe(mdN);
  const mdN1 = generateMetricsMd(next);
  expect(generateMetricsMd(applyChange(base, change))).toBe(mdN1);
  const a = mdN.split("\n");
  const b = mdN1.split("\n");
  expect(a.length).toBe(b.length);
  const changedLines = b
    .map((l, i) => (l === a[i] ? null : { n: i + 1, from: a[i], to: l }))
    .filter((x) => x !== null);
  const inSection = (n: number) => {
    const start = b.findIndex((l) => l === `## ${METRIC}`);
    const end = b.findIndex((l, i) => i > start && l.startsWith("<a id="));
    return n > start && n <= (end < 0 ? b.length : end);
  };
  for (const c of changedLines) {
    const header =
      /^- (Semantic version|Content hash):/.test(c!.to) ||
      /^\| \[`near\.distinct_signer_proxy`\]/.test(c!.to);
    expect(header || inSection(c!.n), `unexpected change line ${c!.n}: ${c!.to}`).toBe(true);
  }
  observe({
    testId: "S12",
    observed: `proposal inactive (active stays ${N} / ${base.contentHash.slice(0, 12)}); diff has old/new mean (${report.old.mean} -> ${report.new.mean}), coverage, null days (${report.old.nullDays} -> ${report.new.nullDays}), column changes, ${report.dependentPanels.length} panel + ${report.dependentClaims.length} claim dependents; approval -> ${active1.semanticVersion} / ${active1.contentHash.slice(0, 12)} recorded with approver and diff hash; exp.custom_ratio promotion refused and labelled unverified; METRICS.md deterministic, ${changedLines.length} changed lines all in header/intended metric`,
    fixtureHash: baseline().digest,
    evidence: {
      versionBefore: { semanticVersion: N, contentHash: base.contentHash },
      versionAfter: { semanticVersion: active1.semanticVersion, contentHash: active1.contentHash },
      diffReport: report,
      diffHash,
      promotionRow: row,
      refusedPromotion: refused.rows[0],
      metricsMdChangedLines: changedLines,
      metricsMdSha256: { before: sha256(mdN), after: sha256(mdN1) },
      changeHash: sha256(canonicalJson(change)),
    },
  });
});
