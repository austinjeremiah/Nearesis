import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SpendGate } from "@nearesis/contracts";
import {
  base58Decode,
  base58Encode,
  buildCapsule,
  buildLiveCapsuleInput,
  encodeFunctionCallTx,
  parseOutcome,
  proveCapsule,
  ProveRefused,
  verifyStoredOutlayerProof,
  type ExecutionReceipt,
  type OutlayerAttestationRecord,
  type OutlayerChain,
} from "../src/index.ts";
import { APP, PKG, SNAPSHOT, WASM, liveOutlayerV10, tmp } from "./helpers.ts";

/** The recorded REAL OutLayer testnet attestation (request 29674) stands in for the coordinator; no network is used. */
const receiptFor = (requestId: number, txHash: string, deposit: string): ExecutionReceipt => ({
  requestId,
  txHash,
  depositYocto: deposit,
  tokensBurntYocto: "60000000000000000000",
  chargedYocto: "1049100200000000000000",
  refundedYocto: null,
  instructionsUsed: 2_173_714,
  outputKind: "json",
  signer: "majorlynx5104.testnet",
});

function fakeChain(o: { record?: Partial<OutlayerAttestationRecord> | null; deposit?: string } = {}) {
  const live = liveOutlayerV10();
  const calls: string[] = [];
  const chain: OutlayerChain = {
    account: "majorlynx5104.testnet",
    estimateDeposit: async () => (calls.push("estimate"), o.deposit ?? "2000100000000000000000"),
    wasmAvailable: async () => (calls.push("wasm"), true),
    balanceYocto: async () => "0",
    fetchReceipt: async (h) => (
      calls.push(`receipt:${h}`),
      receiptFor(live.record.request_id, live.record.transaction_hash, "2000100000000000000000")
    ),
    requestExecution: async (r, deposit) => {
      calls.push(`request:${deposit}`);
      expect(r.inputData).toBe(live.inputData);
      const receipt = receiptFor(live.record.request_id, live.record.transaction_hash, deposit);
      return receipt;
    },
    fetchAttestation: async () => (
      calls.push("attestation"),
      o.record === null ? null : { ...live.record, ...o.record }
    ),
  };
  return { chain, calls, live };
}

const setup = () => {
  const capsuleDir = tmp("prove-cap-");
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: capsuleDir });
  return { capsuleDir, outDir: tmp("prove-out-"), policy: liveOutlayerV10().policy };
};
const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");

describe("research:prove (injected chain)", () => {
  it("default path reproduces locally and says it is NOT attested", async () => {
    const { capsuleDir, outDir, policy } = setup();
    const doc = await proveCapsule({ capsuleDir, wasmPath: WASM, policy, outDir });
    expect(doc.labels).toEqual({ reproduction: "reproduced", attestation: "not_requested" });
    expect(doc.job).toBeNull();
    expect(doc.proofRecord).toBeNull();
    expect(doc.statement).toContain("NOT attested");
  });

  it("live path: attested only after verifyOutlayerLive accepts and the output equals the local run", async () => {
    const { capsuleDir, outDir, policy } = setup();
    const { chain, calls } = fakeChain();
    const spends: string[] = [];
    const doc = await proveCapsule({
      capsuleDir,
      wasmPath: WASM,
      policy,
      outDir,
      live: { chain, budgetYocto: 10n ** 22n, recordSpend: (e) => spends.push(e.txHash) },
    });
    expect(doc.verification?.reasons).toEqual([]);
    expect(doc.labels).toEqual({ reproduction: "reproduced", attestation: "attested" });
    expect(doc.evidenceSource).toBe("live");
    expect(doc.attestedOutputSha256).toBe(doc.localOutputSha256);
    expect(doc.verification?.collateralChecked).toBe(false);
    expect(doc.proofRecord?.status).toBe("verified");
    expect(calls).toEqual(["wasm", "estimate", "request:2000100000000000000000", "attestation"]);
    expect(spends).toHaveLength(1);
    // the stored proof re-verifies offline, and a tampered copy does not
    const proofPath = join(outDir, `${doc.capsuleId}.outlayer-proof.json`);
    expect(verifyStoredOutlayerProof(proofPath, capsuleDir, policy)).toEqual({ ok: true, reasons: [] });
    const att = join(outDir, doc.attestationFile!);
    const rec = JSON.parse(readFileSync(att, "utf8")) as OutlayerAttestationRecord;
    writeFileSync(att, JSON.stringify({ ...rec, output_hash: flip(rec.output_hash) }));
    expect(verifyStoredOutlayerProof(proofPath, capsuleDir, policy).ok).toBe(false);
  });

  it("a mismatching attestation is rejected and gets no attested label", async () => {
    const { capsuleDir, outDir, policy } = setup();
    const bad = fakeChain({ record: { output_hash: flip(liveOutlayerV10().record.output_hash) } });
    const doc = await proveCapsule({
      capsuleDir,
      wasmPath: WASM,
      policy,
      outDir,
      live: { chain: bad.chain, budgetYocto: 10n ** 22n },
    });
    expect(doc.labels).toEqual({ reproduction: "reproduced", attestation: "rejected" });
    expect(doc.proofRecord).toBeNull();
    expect(doc.verification?.reasons).toContain("OUTPUT_HASH_MISMATCH");
    const other = fakeChain({ record: { request_id: 1 } });
    const d2 = await proveCapsule({
      capsuleDir,
      wasmPath: WASM,
      policy,
      outDir,
      live: { chain: other.chain, budgetYocto: 10n ** 22n },
    });
    expect(d2.labels.attestation).toBe("rejected");
    expect(d2.verification?.reasons).toContain("ATTESTATION_REQUEST_ID_MISMATCH");
  });

  it("no attestation before the timeout leaves the proof pending, never attested", async () => {
    const { capsuleDir, outDir, policy } = setup();
    const { chain } = fakeChain({ record: null });
    const doc = await proveCapsule({
      capsuleDir,
      wasmPath: WASM,
      policy,
      outDir,
      live: { chain, budgetYocto: 10n ** 22n },
    });
    expect(doc.labels.attestation).toBe("pending");
    expect(doc.job?.requestId).toBeGreaterThan(0);
  });

  it("refuses over budget before submitting, and a refused spend never reaches OutLayer", async () => {
    const { capsuleDir, outDir, policy } = setup();
    const a = fakeChain({ deposit: "20000000000000000000000" }); // 0.02 NEAR
    await expect(
      proveCapsule({
        capsuleDir,
        wasmPath: WASM,
        policy,
        outDir,
        live: { chain: a.chain, budgetYocto: 10n ** 22n },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(a.calls).toEqual(["wasm", "estimate"]);
    const b = fakeChain();
    const gate: SpendGate = {
      authorize: async () => {
        throw Object.assign(new Error("blocked"), { name: "CostBlockedError" });
      },
      settle: async () => undefined,
      release: async () => undefined,
      observe: async () => undefined,
    };
    await expect(
      proveCapsule({
        capsuleDir,
        wasmPath: WASM,
        policy,
        outDir,
        live: { chain: b.chain, gate, budgetYocto: 10n ** 22n },
      }),
    ).rejects.toThrow("blocked");
    expect(b.calls.some((c) => c.startsWith("request"))).toBe(false);
  });

  it("refuses an unpinned wasm and a capsule whose input was altered", async () => {
    const { capsuleDir, outDir, policy } = setup();
    await expect(
      proveCapsule({ capsuleDir, wasmPath: WASM, policy: { ...policy, allowedWasmSha256: [] }, outDir }),
    ).rejects.toBeInstanceOf(ProveRefused);
    const f = join(capsuleDir, "computation", "verifier-input.json");
    writeFileSync(f, `${readFileSync(f, "utf8")} `);
    await expect(proveCapsule({ capsuleDir, wasmPath: WASM, policy, outDir })).rejects.toMatchObject({
      code: "CAPSULE_INPUT_MISMATCH",
    });
    mkdirSync(outDir, { recursive: true });
  });
});

describe("testnet chain helpers", () => {
  it("base58 round-trips and the transaction layout matches borsh", () => {
    const h = "CgK37LgiHSC9TGjhgEVmWfAE3kG4WfpF1b11APm19BD8";
    expect(base58Encode(base58Decode(h))).toBe(h);
    expect(base58Decode(h)).toHaveLength(32);
    const tx = encodeFunctionCallTx({
      signerId: "a.testnet",
      publicKey: Buffer.alloc(32, 7),
      nonce: 5n,
      receiverId: "outlayer.testnet",
      blockHash: Buffer.alloc(32, 9),
      method: "request_execution",
      args: Buffer.from("{}"),
      gas: 300_000_000_000_000n,
      deposit: 2_000_100_000_000_000_000_000n,
    });
    // 4+9 signer, 33 key, 8 nonce, 4+16 receiver, 32 hash, 4 actions, 1 tag, 4+17 method, 4+2 args, 8 gas, 16 deposit
    expect(tx.length).toBe(13 + 33 + 8 + 20 + 32 + 4 + 1 + 21 + 6 + 8 + 16);
    expect(tx.subarray(tx.length - 16).readBigUInt64LE(0)).toBe(
      2_000_100_000_000_000_000_000n & 0xffffffffffffffffn,
    );
  });

  it("parseOutcome extracts the request id and fails closed on a failed receipt", () => {
    const ev = JSON.stringify({
      event: "execution_requested",
      data: [{ request_data: JSON.stringify({ request_id: 29674 }) }],
    });
    const ok = {
      status: { SuccessValue: "" },
      transaction: { hash: "H" },
      transaction_outcome: { outcome: { tokens_burnt: "5" } },
      receipts_outcome: [
        { outcome: { tokens_burnt: "7", logs: [`EVENT_JSON:${ev}`], status: { SuccessValue: "" } } },
      ],
    };
    const r = parseOutcome(ok, "me.testnet", "9");
    expect(r).toMatchObject({ requestId: 29674, txHash: "H", tokensBurntYocto: "12", depositYocto: "9" });
    expect(() =>
      parseOutcome(
        { ...ok, receipts_outcome: [{ outcome: { tokens_burnt: "1", logs: [], status: { Failure: {} } } }] },
        "m",
        "1",
      ),
    ).toThrow("failed");
  });
});

describe("resume and text-mode outputs", () => {
  it("resume verifies an already-executed job without spending (no estimate, no request)", async () => {
    const { capsuleDir, outDir, policy } = setup();
    const { chain, calls } = fakeChain();
    const doc = await proveCapsule({
      capsuleDir,
      wasmPath: WASM,
      policy,
      outDir,
      live: { chain, budgetYocto: 0n, resume: { txHash: "T" } },
    });
    expect(doc.labels.attestation).toBe("attested");
    expect(calls).toEqual(["receipt:T", "attestation"]);
  });

  // Recorded from OutLayer testnet request 31106 (tx 9bmC5uig...), produced by research:prove on the live capsule input.
  // The worker classed that output as text, so its output_hash is the hash of the JSON string encoding of the stdout.
  it("accepts the real recorded attestation of the live capsule job (text-mode output)", async () => {
    const dir = tmp("prove-live-");
    const snap = tmp("prove-live-snap-");
    buildLiveCapsuleInput({
      liveSnapshotDir: join(
        APP,
        "docs",
        "research",
        "live-snapshots",
        "live-20260603-20261111-live-organic-v2-15fe2ad62d6c",
      ),
      outDir: snap,
      analysisCodeCommit: "0000000000000000000000000000000000000000",
    });
    buildCapsule({ snapshotDir: snap, outDir: dir });
    const rec = JSON.parse(
      readFileSync(join(PKG, "test", "fixtures", "outlayer-live-capsule", "attestation.json"), "utf8"),
    ) as OutlayerAttestationRecord;
    const policy = liveOutlayerV10().policy;
    const chain: OutlayerChain = {
      ...fakeChain().chain,
      fetchReceipt: async () => ({
        ...receiptFor(rec.request_id, rec.transaction_hash, "1500100000000000000000"),
        outputKind: "text",
      }),
      fetchAttestation: async () => rec,
    };
    const outDir = tmp("prove-live-out-");
    const doc = await proveCapsule({
      capsuleDir: dir,
      wasmPath: WASM,
      policy,
      outDir,
      live: { chain, budgetYocto: 0n, resume: { txHash: rec.transaction_hash } },
    });
    expect(doc.verification?.reasons).toEqual([]);
    expect(doc.outputEncoding).toBe("text");
    expect(doc.labels.attestation).toBe("attested");
    // the same record claimed as a JSON-mode output must not verify
    const wrong = await proveCapsule({
      capsuleDir: dir,
      wasmPath: WASM,
      policy,
      outDir,
      live: {
        chain: {
          ...chain,
          fetchReceipt: async () => ({
            ...receiptFor(rec.request_id, rec.transaction_hash, "1"),
            outputKind: "json",
          }),
        },
        budgetYocto: 0n,
        resume: { txHash: "x" },
      },
    });
    expect(wrong.labels.attestation).toBe("rejected");
    expect(wrong.verification?.reasons).toContain("OUTPUT_HASH_MISMATCH");
  });
});
