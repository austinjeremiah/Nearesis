/**
 * SEC22: the security release gate. PASS: every NO-GO class produces NO GO; a human owner/admin waiver with an independent
 * reviewer is accepted and recorded for a non-critical documented weakness, while an agent-authored waiver and a waiver on
 * a critical or NO-GO finding are refused (a `waiver: true` flag is ignored); the leak-response runbook rotates the secret,
 * disables the plugin, lists the canary's occurrences in logs and outbox contents and writes an owner notification; audit
 * events are retained and append-only.
 * Real kernel, real Postgres (disposable), real plugin on the real execution path, real credential source.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { CredentialSource } from "../../services/ingestion/src/http/credentials.ts";
import { LeakRunbook, NO_GO_CLASSES, ReleaseGate, historyService } from "../../packages/kernel/src/index.ts";
import type { ReleaseFinding, Session } from "../../packages/kernel/src/index.ts";
import { loginSession } from "../../packages/kernel/test/helpers/index.ts";
import { rig } from "./_plugin-harness.ts";
import type { Rig } from "./_plugin-harness.ts";

let r: Rig;
beforeAll(async () => {
  r = await rig({ prefix: "sec22" });
}, 120_000);
afterAll(async () => r?.drop());

const finding = (id: string, over: Partial<ReleaseFinding> = {}): ReleaseFinding => ({
  id,
  class: "other",
  severity: "medium",
  title: `weakness ${id}`,
  documented: true,
  ...over,
});
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "ACCEPTED",
    (e) => (e as { reasonCode?: string }).reasonCode ?? (e as { code?: string }).code ?? "error",
  );

it("SEC22: NO-GO enforcement, human-only waivers and the leak-response runbook", async () => {
  const admin = r.db.admin;
  const add = async (name: string, role: "admin" | "analyst") => {
    const id = randomUUID();
    const subject = `sec22.${name}.${randomUUID().slice(0, 6)}`;
    await admin.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)", [
      id,
      subject,
      name,
    ]);
    await admin.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,$3)", [
      r.orgId,
      id,
      role,
    ]);
    return { id, session: await loginSession(r.k, subject) };
  };
  const rita = await add("rita", "admin");
  const ann = await add("ann", "analyst");
  const owner = r.human;
  const agent = {
    principal: { kind: "agent", actorId: randomUUID(), orgId: r.orgId, parentRunId: randomUUID() },
    role: "analyst",
    userId: randomUUID(),
  } as unknown as Session;
  const gate = new ReleaseGate(r.k.db);

  // ---- (a) every NO-GO class, alone and with a clean companion; critical severity in any class
  // ch.12 lists exactly 7 NO-GO classes; a shorter list would silently skip one
  expect([...NO_GO_CLASSES]).toEqual([
    "tenant_leak",
    "public_secret",
    "mainnet_action",
    "unverified_tee_proof",
    "canvas_code_execution",
    "unbounded_agent_spawn",
    "plugin_egress",
  ]);
  const classDecisions: Record<string, string> = {};
  for (const cls of NO_GO_CLASSES) {
    const d = await gate.evaluate(owner, [
      finding("ok-1"),
      finding(`nogo-${cls}`, { class: cls, severity: "high" }),
    ]);
    classDecisions[cls] = d.decision;
    expect(d.decision).toBe("NO_GO");
    expect(d.reasons.some((x) => x.findingId === `nogo-${cls}` && x.rule === "NO_GO_CLASS")).toBe(true);
  }
  const criticalOther = await gate.evaluate(owner, [finding("crit-1", { severity: "critical" })]);
  expect(criticalOther.decision).toBe("NO_GO");
  expect((await gate.evaluate(owner, [])).decision).toBe("GO"); // control: an empty finding set passes
  expect((await gate.evaluate(owner, [finding("plain")])).decision).toBe("HOLD"); // unwaived weakness holds

  // ---- (b) waivers
  const base = {
    findingClass: "other" as const,
    severity: "medium" as const,
    rationale: "documented, bounded, tracked",
  };
  const w1 = await gate.signWaiver(owner, {
    ...base,
    findingId: "W1",
    reviewerId: rita.id,
    independentReviewRef: "REVIEW-2026-11-11-001",
  });
  expect(w1).toMatchObject({
    signerKind: "human",
    signerId: owner.userId,
    reviewerId: rita.id,
    independentReviewRef: "REVIEW-2026-11-11-001",
  });
  const accepted = await gate.evaluate(owner, [finding("W1")]);
  expect(accepted.decision).toBe("GO");
  expect(accepted.acceptedWaivers.map((w) => w.id)).toEqual([w1.id]);

  const refused: Record<string, string> = {};
  refused.agentAuthored = await refusal(
    gate.signWaiver(agent, {
      ...base,
      findingId: "W2",
      reviewerId: rita.id,
      independentReviewRef: "REVIEW-X",
    }),
  );
  refused.criticalByHuman = await refusal(
    gate.signWaiver(owner, {
      ...base,
      severity: "critical",
      findingId: "C1",
      reviewerId: rita.id,
      independentReviewRef: "REVIEW-Y",
    }),
  );
  refused.noGoClassByHuman = await refusal(
    gate.signWaiver(owner, {
      ...base,
      findingClass: "plugin_egress",
      findingId: "C2",
      reviewerId: rita.id,
      independentReviewRef: "REVIEW-Z",
    }),
  );
  refused.selfReview = await refusal(
    gate.signWaiver(owner, {
      ...base,
      findingId: "W3",
      reviewerId: owner.userId,
      independentReviewRef: "REVIEW-S",
    }),
  );
  refused.analystReviewer = await refusal(
    gate.signWaiver(owner, {
      ...base,
      findingId: "W4",
      reviewerId: ann.id,
      independentReviewRef: "REVIEW-A",
    }),
  );
  refused.analystSigner = await refusal(
    gate.signWaiver(ann.session, {
      ...base,
      findingId: "W5",
      reviewerId: rita.id,
      independentReviewRef: "REVIEW-B",
    }),
  );
  refused.undocumented = await refusal(
    gate.signWaiver(
      owner,
      { ...base, findingId: "W6", reviewerId: rita.id, independentReviewRef: "REVIEW-C" },
      false,
    ),
  );
  expect(refused).toEqual({
    agentAuthored: "AGENT_CANNOT_WAIVE",
    criticalByHuman: "CRITICAL_NOT_WAIVABLE",
    noGoClassByHuman: "CRITICAL_NOT_WAIVABLE",
    selfReview: "WAIVER_NOT_AUTHORISED",
    analystReviewer: "WAIVER_NOT_AUTHORISED",
    analystSigner: "WAIVER_NOT_AUTHORISED",
    undocumented: "WEAKNESS_NOT_DOCUMENTED",
  });
  // the database refuses the same attempts when the service layer is bypassed
  const direct = async (
    ctx: { userId: string; actorKind: "human" | "agent" | "service" },
    sev: string,
    cls: string,
  ) =>
    refusal(
      r.k.db
        .tx({ orgId: r.orgId, ...ctx }, (tx) =>
          tx.query(
            "SELECT release_waiver_sign($1,'D1',$2,$3,'a sufficiently long rationale',$4,'REVIEW-D',NULL)",
            [randomUUID(), cls, sev, rita.id],
          ),
        )
        .then(() => "ACCEPTED"),
    );
  const dbAgent = await direct({ userId: agent.userId, actorKind: "agent" }, "medium", "other");
  const dbCritical = await direct({ userId: owner.userId, actorKind: "human" }, "critical", "other");
  const dbSql = await refusal(
    r.k.db.tx({ orgId: r.orgId, userId: owner.userId, actorKind: "human" }, (tx) =>
      tx.query(
        "INSERT INTO release_waivers(id, org_id, finding_id, finding_class, severity, rationale, signer_id, signer_kind, reviewer_id, independent_review_ref) VALUES (gen_random_uuid(), $1, 'S1', 'other', 'low', 'direct sql forged waiver', $2, 'human', $3, 'REVIEW-E')",
        [r.orgId, owner.userId, rita.id],
      ),
    ),
  );
  expect([dbAgent, dbCritical]).toEqual(["42501", "23514"]);
  expect(dbSql).toBe("42501");
  expect((await gate.evaluate(owner, [finding("W2")])).decision).toBe("HOLD"); // the refused agent waiver left no record
  // a forged row inserted outside every application path (superuser) is still not honoured
  await admin.query(
    "INSERT INTO release_waivers(id, org_id, finding_id, finding_class, severity, rationale, signer_id, signer_kind, reviewer_id, independent_review_ref) VALUES (gen_random_uuid(), $1, 'W2', 'other', 'medium', 'forged agent-authored waiver', $2, 'agent', $3, 'REVIEW-F')",
    [r.orgId, agent.userId, rita.id],
  );
  await admin.query(
    "INSERT INTO release_waivers(id, org_id, finding_id, finding_class, severity, rationale, signer_id, signer_kind, reviewer_id, independent_review_ref) VALUES (gen_random_uuid(), $1, 'C9', 'plugin_egress', 'critical', 'forged waiver on a critical item', $2, 'human', $3, 'REVIEW-G')",
    [r.orgId, owner.userId, rita.id],
  );
  const forged = await gate.evaluate(owner, [
    finding("W2"),
    finding("C9", { class: "plugin_egress", severity: "critical" }),
  ]);
  expect(forged.decision).toBe("NO_GO");
  expect(forged.reasons.map((x) => x.rule)).toContain("WAIVER_INVALID");
  expect(forged.reasons.some((x) => x.findingId === "W2" && x.rule === "UNWAIVED")).toBe(true);
  // a `waiver: true` flag on a finding is ignored
  const flagged = await gate.evaluate(owner, [
    finding("F1", { waiver: true }),
    finding("F2", { severity: "critical", waiver: true }),
  ]);
  expect(flagged.decision).toBe("NO_GO");
  expect(flagged.reasons.some((x) => x.findingId === "F1" && x.rule === "UNWAIVED")).toBe(true);
  const audited = Number(
    (
      await admin.query(
        "SELECT count(*)::int n FROM audit_events WHERE action = 'release_gate.waiver_refused'",
      )
    ).rows[0].n,
  );
  expect(audited).toBe(Object.keys(refused).length);

  // ---- (c) the leak-response runbook for a canary secret
  const CANARY = `sk-canary-${randomUUID()}`;
  const creds = CredentialSource.fromMap({ PROVIDER_KEY: CANARY });
  const ver = Number(
    (await admin.query("SELECT version FROM workspaces WHERE id = $1", [r.workspaceId])).rows[0].version,
  );
  await historyService(r.k).graphOps.addNode(owner, r.workspaceId, {
    expectedVersion: ver,
    kind: "observation",
    label: `pasted by mistake: ${CANARY}`,
  });
  const outboxRow = (await admin.query("SELECT id FROM outbox ORDER BY created_at LIMIT 1")).rows[0]
    .id as string;
  await admin.query("UPDATE outbox SET last_error = $2 WHERE id = $1", [
    outboxRow,
    `consumer failed with key ${CANARY}`,
  ]);
  const logs = [
    "GET /v1/x 200",
    `POST /v1/y authorization=${CANARY}`,
    "GET /v1/z 200",
    `retry body key=${CANARY}`,
  ];
  const before = await r.invoke({ action: "ok" });
  expect(before.state).toBe("ok");
  const report = await new LeakRunbook(r.k.db, r.k.plugins).run(owner, {
    secret: CANARY,
    pluginId: "sec-hostile",
    rotate: async () => creds.rotate("PROVIDER_KEY", `rotated-${randomUUID()}`),
    requestLogs: logs,
  });
  const after = await r.invoke({ action: "ok" });
  expect(creds.get("PROVIDER_KEY")).not.toBe(CANARY);
  expect(report.rotated && report.pluginDisabled).toBe(true);
  expect(after.state).toBe("blocked");
  expect((after as { reasonCode?: string }).reasonCode).toBe("PLUGIN_DISABLED");
  expect(
    (await admin.query("SELECT state FROM plugin_installations WHERE plugin_id = 'sec-hostile'")).rows[0]
      .state,
  ).toBe("disabled");
  const bySource = report.occurrences.reduce<Record<string, number>>(
    (m, o) => ((m[o.source] = (m[o.source] ?? 0) + 1), m),
    {},
  );
  expect(bySource).toEqual({ request_log: 2, workspace_events: 1, outbox: 1 });
  expect(report.occurrences.filter((o) => o.source === "request_log").map((o) => o.ref)).toEqual([
    "line:2",
    "line:4",
  ]);
  const note = (
    await admin.query("SELECT kind, subject, detail FROM owner_notifications WHERE id = $1", [
      report.notificationId,
    ])
  ).rows[0];
  expect(note.kind).toBe("secret_leak");
  const everything = JSON.stringify([
    report,
    note,
    (await admin.query("SELECT * FROM audit_events WHERE action LIKE 'leak_response.%'")).rows,
  ]);
  expect(everything.includes(CANARY)).toBe(false); // neither the report, the notification nor the audit trail holds the secret
  expect(
    Number(
      (await admin.query("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'leak_response.%'"))
        .rows[0].n,
    ),
  ).toBe(4);

  // ---- (d) audit retention and append-only
  await admin.query(
    "INSERT INTO audit_events(id, org_id, action, outcome, occurred_at) VALUES (gen_random_uuid(), $1, 'sec22.old', 'ok', now() - interval '400 days')",
    [r.orgId],
  );
  const retention = await gate.auditRetention(owner);
  const tooShort = await new ReleaseGate(r.k.db, { auditRetentionDays: 30 }).auditRetention(owner);
  expect(retention.withinPolicy).toBe(true);
  expect(Date.now() - new Date(retention.oldestKept!).getTime()).toBeGreaterThan(399 * 86_400_000);
  expect(tooShort.withinPolicy).toBe(false);
  const ctx = { orgId: r.orgId, userId: owner.userId, actorKind: "human" as const };
  const mutate: Record<string, string> = {};
  for (const [verb, sql] of [
    ["update", "UPDATE audit_events SET outcome = 'ok'"],
    ["delete", "DELETE FROM audit_events"],
    ["truncate", "TRUNCATE audit_events"],
  ] as const)
    mutate[verb] = await refusal(r.k.db.tx(ctx, (tx) => tx.query(sql)));
  expect(mutate).toEqual({ update: "42501", delete: "42501", truncate: "42501" });

  observe({
    testId: "SEC22",
    observed: `NO-GO: ${NO_GO_CLASSES.length} classes (${NO_GO_CLASSES.join(", ")}) each NO_GO even next to a clean finding, a critical finding in an ordinary class NO_GO, empty set GO, unwaived weakness HOLD; waivers: a human owner waiver with an independent admin reviewer and review ref accepted, recorded (signer kind human, reviewer, ref) and the gate returned GO; refused and audited (${audited}): agent-authored (AGENT_CANNOT_WAIVE), critical item and NO-GO class by a human (CRITICAL_NOT_WAIVABLE), self review, analyst reviewer, analyst signer (WAIVER_NOT_AUTHORISED), undocumented weakness; the database refused the same attempts without the service layer (agent 42501, critical 23514, direct INSERT 42501); a forged agent-authored waiver row and a forged waiver on a critical item inserted as superuser were not honoured (HOLD and NO_GO with WAIVER_INVALID); finding fields waiver:true ignored; runbook on a canary secret: rotated (source no longer returns it), plugin disabled (next invocation PLUGIN_DISABLED), review listed ${report.occurrences.length} occurrences (${JSON.stringify(bySource)}), owner notification written, 4 leak_response audit events, secret absent from report, notification and audit trail; audit retention: 400-day-old event retained, retention ${retention.retentionDays} days within policy (a 30-day policy is flagged), UPDATE, DELETE and TRUNCATE on audit_events refused 42501`,
    fixtureHash: createHash("sha256").update("sec22-v1").digest("hex"),
    evidence: {
      classDecisions,
      refused,
      database: { dbAgent, dbCritical, dbSql },
      forgedWaivers: forged.reasons,
      runbook: {
        occurrences: report.occurrences,
        fingerprint: report.secretFingerprint,
        notificationId: report.notificationId,
      },
      retention,
      auditAppendOnly: mutate,
    },
  });
}, 300_000);
