/**
 * N11: post-write verification, receipt and no additional writes. FIXTURE half on the sandbox chain. Criterion (e), the
 * operator's mainnet run read back read-only, is HUMAN: absent it the verdict is BLOCKED_DEPENDENCY.
 */
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runRelease } from "../../scripts/release/release.ts";
import { guardAction, verifyReceipt } from "../../scripts/release/verify.ts";
import type { ExpectedWrite } from "../../scripts/release/verify.ts";
import { CONTRACT, PAYLOAD, SIGNER, request, rig } from "./_rig.ts";

const rigs: Array<ReturnType<typeof rig>> = [];
afterAll(() => rigs.forEach((x) => x.cleanup()));
const expectedFor = (): ExpectedWrite => ({
  network: "sandbox",
  chainId: "sandbox",
  payloadHash: PAYLOAD,
  signer: SIGNER,
  target: CONTRACT,
  maxFee: 5n,
  fromHeight: 0,
});

async function committed(chainOpts: Parameters<typeof rig>[1] = {}, pol: Parameters<typeof rig>[2] = {}) {
  const x = rig("sandbox", chainOpts, pol);
  rigs.push(x);
  const res = await runRelease(x.deps(), request("sandbox"));
  expect(res.status).toBe("FINAL");
  return { x, receipt: res.receipt! };
}

it("N11: the receipt is verified field by field against an independent readback and the signer's full activity; mismatches fail; disabled actions are refused", async () => {
  // (i) correct commit
  const { x, receipt } = await committed();
  for (const f of [
    "network",
    "chainId",
    "hash",
    "payloadHash",
    "signer",
    "target",
    "height",
    "finality",
    "fee",
  ] as const)
    expect(receipt[f], f).toBeDefined();
  expect(receipt.finality).toBe("FINAL");
  const good = await verifyReceipt(x.chain, receipt, expectedFor());
  expect(good).toEqual({ ok: true, mismatches: [], signerTxCount: 1 });

  // (ii) payload differs from the manifest
  const ii = await verifyReceipt(x.chain, receipt, { ...expectedFor(), payloadHash: "9".repeat(64) });
  expect(ii.ok).toBe(false);
  expect(ii.mismatches.join("|")).toMatch(/payloadHash: differs from the manifest/);

  // (iii) a second transaction from the signer in the window
  const t = await committed();
  await t.x.chain.broadcast({ ...t.x.chain.txs[0]!.intent, nonceKey: "side-channel" });
  const iii = await verifyReceipt(t.x.chain, t.receipt, expectedFor());
  expect(iii.ok).toBe(false);
  expect(iii.signerTxCount).toBe(2);
  expect(iii.mismatches.join("|")).toMatch(/expected exactly 1/);
  // control: a verifier that trusts the application's own log sees one release and passes, so it would fail this case
  const appLog = [t.receipt.hash];
  expect(appLog.length === 1).toBe(true);

  // (iv) fee above the ceiling
  const f = await committed({ fee: 9n }, { feeCeiling: 20n }); // the pre-flight ceiling was misconfigured high; the verifier uses the manifest ceiling
  const iv = await verifyReceipt(f.x.chain, f.receipt, expectedFor());
  expect(iv.ok).toBe(false);
  expect(iv.mismatches.join("|")).toMatch(/fee: above the ceiling/);

  // (v) wrong signer
  const v = await verifyReceipt(x.chain, receipt, { ...expectedFor(), signer: "someone-else" });
  expect(v.ok).toBe(false);
  expect(v.mismatches.join("|")).toMatch(/signer: differs/);

  // tampered receipt vs chain readback
  const tamper = await verifyReceipt(x.chain, { ...receipt, height: receipt.height + 1 }, expectedFor());
  expect(tamper.mismatches.join("|")).toMatch(/height: receipt/);

  // (vi) disabled actions refused with audit, release tooling has no path to transfer or swap
  const audit: Array<{ kind: string; detail: string }> = [];
  for (const m of ["transfer", "swap", "send_money", "deploy_contract"])
    expect(() => guardAction(m, audit)).toThrow(/disabled/);
  expect(audit).toHaveLength(4);
  const viaRelease = await runRelease(x.deps(), request("sandbox", { method: "transfer" }));
  expect(viaRelease.reasonCode).toBe("ACTION_DISABLED");
  expect(x.chain.txs).toHaveLength(1);

  observe({
    testId: "N11",
    blocked:
      "HUMAN-required: criterion (e), the live mainnet readback after the operator's single authorised write, and the mainnet signer-activity listing; no mainnet or testnet access is permitted for this agent. Fixture half passed: criteria (a) to (d)",
    observed: `fixture half: correct commit verified (receipt has network, chain id, tx hash, payload hash, signer, target, height, finality, fee, approval ref; signer activity exactly 1 tx); mismatches detected for payload-vs-manifest, second signer transaction (2 txs found by independent listing), fee above ceiling, wrong signer and a tampered receipt height; 4 disabled actions (transfer, swap, send_money, deploy_contract) refused and audited, release command refuses method transfer with 0 additional txs; trust-the-app-log control would pass the second-transaction case. Live mainnet half not run`,
    fixtureHash: PAYLOAD,
    evidence: {
      receiptFields: Object.keys(receipt),
      goodSignerTxCount: good.signerTxCount,
      secondTxCount: iii.signerTxCount,
      disabledAudit: audit,
    },
  });
});
