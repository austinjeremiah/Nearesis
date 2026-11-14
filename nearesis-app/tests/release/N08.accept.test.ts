/** N08: approval record: exact scope, single use, expiry. FIXTURE half on a sandbox chain; owner issuance in production is HUMAN. */
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { actionHash } from "../../scripts/release/approval.ts";
import { Ledger, runRelease } from "../../scripts/release/release.ts";
import { OWNERS, PAYLOAD, rig, request, scopeOf } from "./_rig.ts";
import { join } from "node:path";

const r = rig(
  "sandbox",
  {},
  {
    approvalRequiredOn: ["sandbox", "testnet", "mainnet"],
    allowlist: {
      contracts: ["prereg.fixture", "other.fixture"],
      methods: ["commit_preregistration_hash", "other_method"],
    },
  },
);
afterAll(r.cleanup);

it("N08: exact execution succeeds once; every altered, expired, used or non-owner approval is denied before signing; a payload-only hash fails the control", async () => {
  const req = request("sandbox");
  const scope = scopeOf(req);
  const appr = r.approvals.issue(scope, OWNERS[0]!, [], 60_000);
  // (a)
  expect(Object.keys(appr).sort()).toEqual([
    "actionHash",
    "createdAt",
    "expiresAt",
    "id",
    "issuer",
    "scope",
    "signers",
    "usedAt",
  ]);
  expect(Object.keys(appr.scope).sort()).toEqual([
    "contract",
    "feeCeiling",
    "maxCost",
    "method",
    "network",
    "payloadHash",
    "signer",
  ]);
  expect(appr.actionHash).toBe(actionHash(scope));
  expect(appr.usedAt).toBeNull();

  // (c) variants altering each scope field, before any execution
  const variants: Record<string, Partial<typeof req>> = {
    network: { network: "testnet" },
    contract: { contract: "other.fixture" },
    method: { method: "other_method" },
    payloadHash: { payloadHash: "b".repeat(64) },
    maxCost: { maxCost: "11" },
  };
  const reasons: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(variants)) {
    const res = await runRelease(r.deps(), { ...req, ...v, approvalId: appr.id });
    expect(res.status, k).toBe("DENIED");
    reasons[k] = res.reasonCode;
  }
  // the signer and the fee ceiling come from the release policy: an approval for one signer or one ceiling never authorises another
  const base = r.deps().policy;
  for (const [k, pol] of Object.entries({
    signer: { ...base, signer: "someone-else.fixture" },
    feeCeiling: { ...base, feeCeiling: base.feeCeiling + 1n },
  })) {
    const res = await runRelease(r.deps({ policy: pol }), { ...req, approvalId: appr.id });
    expect(res.status, k).toBe("DENIED");
    reasons[k] = res.reasonCode;
  }
  expect(Object.values(reasons).every((x) => x === "SCOPE_MISMATCH")).toBe(true);
  expect(r.chain.calls).toEqual({ read: 0, broadcast: 0 });

  // (b) exact execution succeeds exactly once and sets used_at
  const done = await runRelease(r.deps(), { ...req, approvalId: appr.id });
  expect(done.status).toBe("FINAL");
  expect(done.receipt!.approvalRef).toBe(appr.id);
  expect(r.approvals.get(appr.id)!.usedAt).not.toBeNull();
  expect(r.chain.txs).toHaveLength(1);
  // second execution with the same approval (separate release environment) is denied before signing
  const before = { ...r.chain.calls };
  const again = await runRelease(r.deps({ ledger: new Ledger(join(r.dir, "second.json")) }), {
    ...req,
    approvalId: appr.id,
  });
  expect(again.reasonCode).toBe("ALREADY_USED");
  expect(r.chain.calls).toEqual(before);

  // expired and non-owner
  const exp = r.approvals.issue({ ...scope, payloadHash: "c".repeat(64) }, OWNERS[0]!, [], 10);
  r.now.t += 1000;
  const expired = await runRelease(r.deps(), { ...req, payloadHash: "c".repeat(64), approvalId: exp.id });
  expect(expired.reasonCode).toBe("EXPIRED");
  const nonOwner = r.approvals.issue({ ...scope, payloadHash: "d".repeat(64) }, "mallory", [], 60_000);
  const nonOwnerRes = await runRelease(r.deps(), {
    ...req,
    payloadHash: "d".repeat(64),
    approvalId: nonOwner.id,
  });
  expect(nonOwnerRes.reasonCode).toBe("ISSUER_NOT_OWNER");
  expect(r.chain.calls).toEqual(before);

  // (d) two-person policy
  const tp = rig("sandbox", {}, { approvalRequiredOn: ["sandbox"] }, true);
  const single = tp.approvals.issue(scope, OWNERS[0]!, [], 60_000);
  const singleRes = await runRelease(tp.deps(), { ...req, approvalId: single.id });
  expect(singleRes.reasonCode).toBe("TWO_PERSON_REQUIRED");
  const two = tp.approvals.issue({ ...scope, payloadHash: "e".repeat(64) }, OWNERS[0]!, [OWNERS[1]!], 60_000);
  expect(
    (await runRelease(tp.deps(), { ...req, payloadHash: "e".repeat(64), approvalId: two.id })).status,
  ).toBe("FINAL");
  expect(tp.chain.calls.broadcast).toBe(1);
  tp.cleanup();

  // (e) append-only audit
  const kinds = r.approvals.audit.map((a) => a.kind);
  expect(kinds.filter((k) => k === "issued").length).toBe(3);
  expect(kinds.filter((k) => k === "used").length).toBe(1);
  expect(kinds.filter((k) => k === "denied").length).toBeGreaterThanOrEqual(8);
  const snapshot = JSON.stringify(r.approvals.audit);
  expect("revoke" in r.approvals || "delete" in r.approvals).toBe(false);
  expect(JSON.stringify(r.approvals.audit)).toBe(snapshot);

  // negative control: an implementation hashing only the payload accepts changed network and cost
  const weak = (a: { payloadHash: string }, b: { payloadHash: string }) => a.payloadHash === b.payloadHash;
  const weakAcceptsChangedScope = weak(scope, {
    ...scope,
    network: "mainnet",
    maxCost: "999999",
  } as typeof scope);
  expect(weakAcceptsChangedScope).toBe(true); // proves criterion (c) would FAIL for such an implementation

  observe({
    testId: "N08",
    observed: `approval record holds network, contract, method, payload hash, max cost, action hash, issuer, expiry, creation time; exact execution succeeded once (used_at set, 1 transaction); 7 scope variants (network, contract, method, payload hash, max cost, signer, fee ceiling), an expired, a used (separate environment) and a non-owner approval all denied before any chain call (calls unchanged); two-person policy refuses a single signer and accepts two owners; audit shows ${kinds.filter((k) => k === "issued").length} issued, 1 used, ${kinds.filter((k) => k === "denied").length} denied and no delete or update path; payload-only-hash control accepts changed network and cost, so it would fail (c). Owner issuance of a production approval is HUMAN and not exercised here`,
    fixtureHash: PAYLOAD,
    evidence: { variantReasons: reasons, auditKinds: kinds },
  });
});
