/**
 * FND-072 production wiring: the inference-result recorder and label reader built on VerifiedStateService, the
 * activity-level hook that feeds it, and the capsule publication gate. Real kernel and Postgres (disposable).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { StructuredResult, VerificationResult } from "../../packages/contracts/src/index.ts";
import { InferenceVerification, VerifiedStateService } from "../../packages/kernel/src/index.ts";
import { newWs, world } from "../../packages/kernel/test/history/helpers.ts";
import type { World } from "../../packages/kernel/test/history/helpers.ts";

let w: World;
beforeAll(async () => {
  w = await world("sec14w");
}, 120_000);
afterAll(async () => {
  await w?.db.drop();
});

const CHECKS = [
  "tdx_quote_non_debug",
  "measurement_accepted",
  "signer_match",
  "evidence_fresh",
  "response_binding",
] as const;
const verified = (): VerificationResult => ({
  verified: true,
  status: "verified",
  checks: CHECKS.map((name) => ({ name, passed: true, detail: "ok" })),
});
const result = (n: string): StructuredResult<unknown> => ({
  output: { n },
  provider: "near-ai",
  model: "m",
  requestId: null,
  usage: { inputTokens: 1, outputTokens: 1 },
  evidence: null,
  rawResponseSha256: "",
});

it("inference results are recorded through the verifier path and read back with the label a publication must show", async () => {
  const svc = new VerifiedStateService(w.db.app, randomBytes(24).toString("hex"));
  const ws = (await newWs(w)).workspaceId;
  const orgId = w.orgA.orgId;
  const verifierId = randomUUID();
  await w.db.admin.query("INSERT INTO verifier_identities(actor_id, name) VALUES ($1,'sec14-wiring')", [
    verifierId,
  ]);
  const logs: Array<Record<string, unknown>> = [];
  const iv = new InferenceVerification(svc, { verifierId, log: (l) => logs.push(l) });
  const rec = (key: string, v: () => VerificationResult) =>
    iv.record({ orgId, workspaceId: ws, key, result: result(key), verify: async () => v() });
  const label = async (key: string) => (await iv.labelFor({ orgId, workspaceId: ws, key })).badge.label;

  expect(await rec("good", verified)).toBe("verified");
  expect(await rec("dev", () => ({ verified: false, status: "unattested_dev", checks: [] }))).toBe(
    "unverified",
  );
  expect(
    await rec("missing", () => ({
      ...verified(),
      checks: verified().checks.filter((c) => c.name !== "signer_match"),
    })),
  ).toBe("failed");
  expect(
    await rec("badbinding", () => ({
      ...verified(),
      checks: verified().checks.map((c) => (c.name === "response_binding" ? { ...c, passed: false } : c)),
    })),
  ).toBe("failed");
  expect({
    good: await label("good"),
    dev: await label("dev"),
    missing: await label("missing"),
    badbinding: await label("badbinding"),
    never: await label("never-recorded"),
  }).toEqual({
    good: "verified",
    dev: "unverified",
    missing: "failed",
    badbinding: "failed",
    never: "unverified",
  });

  // a verify() that throws records nothing, the result stays unverified and the failure is logged without content
  expect(
    await iv.record({
      orgId,
      workspaceId: ws,
      key: "boom",
      result: result("boom"),
      verify: async () => {
        throw new Error("PRIVATE-DETAIL-xyz");
      },
    }),
  ).toBeNull();
  expect(await label("boom")).toBe("unverified");
  expect(JSON.stringify(logs)).not.toContain("PRIVATE-DETAIL-xyz");

  // a hand-edited row never reads as verified
  await w.db.admin.query("UPDATE verification_states SET state = 'verified' WHERE subject_ref = 'dev'");
  expect(await label("dev")).toBe("failed");
  expect(await label("good")).toBe("verified");

  // a recorder without a verifier identity (or with an unregistered one) writes nothing that can read as verified
  const none = new InferenceVerification(svc, { verifierId: null, log: () => {} });
  expect(none.enabled).toBe(false);
  expect(
    await none.record({
      orgId,
      workspaceId: ws,
      key: "x1",
      result: result("x1"),
      verify: async () => verified(),
    }),
  ).toBeNull();
  const rogue = new InferenceVerification(svc, { verifierId: randomUUID(), log: () => {} });
  expect(
    await rogue.record({
      orgId,
      workspaceId: ws,
      key: "x2",
      result: result("x2"),
      verify: async () => verified(),
    }),
  ).toBeNull();
  expect(await label("x1")).toBe("unverified");
  expect(await label("x2")).toBe("unverified");
});

it("production call sites use it: the activity hook, the composer proposal label and the capsule publication gate", () => {
  const root = join(import.meta.dirname, "../..");
  const act = readFileSync(join(root, "packages/workflow/src/activities.ts"), "utf8");
  expect(act.match(/\.\.\.onResult\(i\.tenantId, i\.workspaceId\)/g)).toHaveLength(2);
  expect(act).toMatch(/d\.verification \?\? null\)\?\.labelFor/);
  const deps = readFileSync(join(root, "packages/workflow/src/kernel-deps.ts"), "utf8");
  expect(deps).toMatch(/verification: new InferenceVerification\(a\.kernel\.verifiedState\)/);
  const caps = readFileSync(join(root, "apps/api/src/capsule-routes.ts"), "utf8");
  expect(caps).toMatch(/kernel\.verifiedState\.gate\(s, owner\.workspaceId, "capsule"/);
});
