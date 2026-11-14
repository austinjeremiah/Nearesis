/* eslint-disable @typescript-eslint/no-explicit-any */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CapsuleResponseRecord } from "@nearesis/contracts";
import {
  APP_ROOT,
  buildCapsule,
  readManifest,
  writeCapsuleOwnership,
} from "../../../packages/capsule/src/index.ts";
import type { OutlayerProofDocument, ProveOptions } from "../../../packages/capsule/src/index.ts";
import { CreditsService } from "@nearesis/kernel";
import { recoverInterruptedProofs } from "../src/proof-routes.ts";
import type { TxStatus } from "../src/credits-routes.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const NEAR = 10n ** 24n;
const DEPOSIT = "majorlynx5104.testnet";
const ALICE = "alice.testnet";
const HOLD = 1_500_100_000_000_000_000_000n + 300_000_000_000_000n * 100_000_000n; // estimate + 300 Tgas at 1e8
const TX = "9bmC5uig8dt1TU4aCmef27X4oQ6aMauaoQM6WgAxkY8i";
const hash = (n: number) =>
  `${"abcdefghijkmnpqrstuvwxyz"[n % 24]}${"ABCDEFGHJK"[Math.floor(n / 24)]}${TX}`.slice(0, 44);

let f: ApiFixture;
let dir: string;
let proofsDir: string;
let spendFile: string;
let capId: string;
let orgId: string;
let aliceId: string;
let ws: string;
const tokens: Record<string, string> = {};
let txImpl: (h: string, who: string) => Promise<TxStatus | null> = async () => null;
let runImpl: (o: ProveOptions) => Promise<OutlayerProofDocument> = async () => {
  throw new Error("no runner");
};
const fakeChain = {
  account: DEPOSIT,
  estimateDeposit: async () => "1500100000000000000000",
  gasPriceYocto: async () => "100000000",
  balanceYocto: async () => "4999000000000000000000000",
  wasmAvailable: async () => true,
  requestExecution: async () => {
    throw new Error("must not be called");
  },
  fetchAttestation: async () => null,
  fetchReceipt: async () => {
    throw new Error("must not be called");
  },
};
const writeSpend = (cap: string) =>
  writeFileSync(
    spendFile,
    JSON.stringify({
      account: DEPOSIT,
      network: "testnet",
      capYocto: cap,
      startBalanceYocto: "5000000000000000000000000",
      entries: [],
    }),
  );

const transfer = (
  o: Partial<TxStatus["transaction"]> = {},
  status: Record<string, unknown> = { SuccessValue: "" },
): TxStatus => ({
  final_execution_status: "FINAL",
  status,
  transaction: {
    signer_id: ALICE,
    receiver_id: DEPOSIT,
    actions: [{ Transfer: { deposit: NEAR.toString() } }],
    ...o,
  },
});
const post = (u: string, t: string, payload: unknown = {}, h: Record<string, string> = {}) =>
  f.app.inject({ method: "POST", url: u, headers: { ...bearer(t), ...h }, payload: payload as object });
const get = (u: string, t: string) => f.app.inject({ method: "GET", url: u, headers: bearer(t) });
const credits = async (t: string) => (await get("/v1/credits", t)).json() as Record<string, any>;
async function settle(proofId: string, t: string) {
  for (let i = 0; i < 100; i++) {
    const p = (await get(`/v1/proofs/${proofId}`, t)).json() as { state: string };
    if (p.state !== "running") return p as Record<string, any>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("proof stayed running");
}
const doc = (
  o: {
    charged?: string | null;
    burnt?: string;
    attested?: boolean;
    requestId?: number;
    txHash?: string;
  } = {},
) =>
  ({
    labels: { reproduction: "reproduced", attestation: o.attested === false ? "rejected" : "attested" },
    attestedOutputSha256: "ab".repeat(32),
    job: {
      requestId: o.requestId ?? 31106,
      txHash: o.txHash ?? TX,
      depositYocto: "1500100000000000000000",
      tokensBurntYocto: o.burnt ?? "1635944140488800000000",
      chargedYocto: o.charged === undefined ? "1051000300000000000000" : o.charged,
    },
    verification: {
      decision: o.attested === false ? "reject" : "accept",
      reasons: o.attested === false ? ["X"] : [],
      mrTd: "11",
      rtmr3: "22",
      taskHash: "t",
      collateralChecked: false,
    },
  }) as unknown as OutlayerProofDocument;
const spendEntry = (h: string) => ({
  at: new Date().toISOString(),
  method: "request_execution (outlayer.testnet) via test",
  txHash: h,
  depositNear: "0.0015001",
  note: "request 31106",
  burntYocto: "1635944140488800000000",
  chargedYocto: "1051000300000000000000",
  requestId: 31106,
  depositYocto: "1500100000000000000000",
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "api-credits-"));
  proofsDir = join(dir, "proofs");
  mkdirSync(proofsDir);
  spendFile = join(dir, "spend.json");
  writeSpend(NEAR.toString());
  process.env.NEARESIS_CAPSULE_DIR = join(dir, "capsules");
  process.env.NEARESIS_PROOF_DIR = proofsDir;
  const m = buildCapsule({
    snapshotDir: join(import.meta.dirname, "../../../packages/capsule/fixtures/snapshot-synthetic"),
    outDir: join(process.env.NEARESIS_CAPSULE_DIR, "cap-synthetic-2026-11-10"),
  });
  capId = m.capsuleId;
  f = await apiFixture({
    appOptions: {
      credits: {
        fetchTx: (h, who) => txImpl(h, who),
        chainFactory: () => fakeChain as never,
        runProof: (o) => runImpl(o),
        spendFile,
        wasmPath: "/nonexistent.wasm",
      },
    },
  });
  const org = await seedOrg(f.db.admin, "acme-credits", { alice: "owner", carol: "owner", vera: "viewer" });
  orgId = org.orgId;
  aliceId = org.users.alice!.userId;
  await f.db.admin.query("UPDATE users SET near_account_id = $2 WHERE id = $1", [aliceId, ALICE]);
  for (const n of ["alice", "carol", "vera"]) tokens[n] = await login(f.app, org.users[n]!.subject);
  const w = await post(
    "/v1/workspaces",
    tokens.alice!,
    { objective: "credits", networkScope: "fixture-only" },
    { "idempotency-key": "credits-ws-0001" },
  );
  ws = (w.json() as { workspaceId: string }).workspaceId;
  writeCapsuleOwnership(join(process.env.NEARESIS_CAPSULE_DIR, capId), { orgId, workspaceId: ws });
});
afterAll(async () => {
  delete process.env.NEARESIS_CAPSULE_DIR;
  delete process.env.NEARESIS_PROOF_DIR;
  delete process.env.NEARESIS_OUTLAYER_LIVE;
  await f?.close();
});

it("requires a session", async () => {
  expect((await f.app.inject({ method: "GET", url: "/v1/credits" })).statusCode).toBe(401);
});

it("GET /v1/credits is zero for a new user and has no estimate while proofs are disabled", async () => {
  const c = await credits(tokens.alice!);
  expect(c).toMatchObject({
    accountId: ALICE,
    balanceYocto: "0",
    heldYocto: "0",
    availableYocto: "0",
    depositAccount: DEPOSIT,
    network: "testnet",
    proofEstimateYocto: null,
    entries: [],
  });
});

it("topup: a caller without a linked NEAR account gets 409 NO_NEAR_ACCOUNT", async () => {
  const r = await post("/v1/credits/topups", tokens.carol!, { txHash: hash(1) });
  expect(r.statusCode).toBe(409);
  expect(r.json()).toMatchObject({ reasonCode: "NO_NEAR_ACCOUNT" });
});

it("topup: malformed hash is a 422", async () => {
  expect((await post("/v1/credits/topups", tokens.alice!, { txHash: "not base58!" })).statusCode).toBe(422);
});

it("topup: every refusal has its own reasonCode and credits nothing", async () => {
  const cases: Array<[string, TxStatus | null]> = [
    ["TX_NOT_FOUND", null],
    ["TX_NOT_FOUND", { ...transfer(), final_execution_status: "EXECUTED_OPTIMISTIC" }],
    ["TX_FAILED", transfer({}, { Failure: { ActionError: {} } })],
    ["TX_FAILED", { ...transfer(), receipts_outcome: [{ outcome: { status: { Failure: {} } } }] }],
    ["WRONG_SIGNER", transfer({ signer_id: "mallory.testnet" })],
    ["WRONG_RECEIVER", transfer({ receiver_id: "other.testnet" })],
    ["NOT_A_TRANSFER", transfer({ actions: [{ FunctionCall: { method_name: "x", deposit: "1" } }] })],
    ["NOT_A_TRANSFER", transfer({ actions: [{ Transfer: { deposit: "5" } }, { DeleteAccount: {} }] })],
    ["NOT_A_TRANSFER", transfer({ actions: [] })],
    ["NOT_A_TRANSFER", transfer({ actions: [{ Transfer: { deposit: "0" } }] })],
  ];
  let i = 10;
  for (const [code, tx] of cases) {
    txImpl = async () => tx;
    const r = await post("/v1/credits/topups", tokens.alice!, { txHash: hash(i++) });
    expect(r.statusCode, code).toBe(422);
    expect(r.json()).toMatchObject({ reasonCode: code });
  }
  expect((await credits(tokens.alice!)).balanceYocto).toBe("0");
});

it("topup: an RPC outage is 503, not a refusal", async () => {
  txImpl = async () => {
    throw new Error("boom");
  };
  const r = await post("/v1/credits/topups", tokens.alice!, { txHash: hash(40) });
  expect(r.statusCode).toBe(503);
  expect(r.json()).toMatchObject({ reasonCode: "NEAR_RPC_UNAVAILABLE" });
});

it("topup: credits the sum of the transfers once; a repeat is 409 TOPUP_ALREADY_CREDITED", async () => {
  let asked: [string, string] | null = null;
  txImpl = async (h, who) => {
    asked = [h, who];
    return transfer({
      actions: [{ Transfer: { deposit: NEAR.toString() } }, { Transfer: { deposit: "5" } }],
    });
  };
  const r = await post("/v1/credits/topups", tokens.alice!, { txHash: hash(50) });
  expect(r.statusCode).toBe(200);
  expect(asked).toEqual([hash(50), ALICE]);
  const c = r.json() as Record<string, any>;
  expect(c.balanceYocto).toBe((NEAR + 5n).toString());
  expect(c.availableYocto).toBe((NEAR + 5n).toString());
  expect(c.entries[0]).toMatchObject({ kind: "topup", amountYocto: (NEAR + 5n).toString(), refId: hash(50) });
  const dup = await post("/v1/credits/topups", tokens.alice!, { txHash: hash(50) });
  expect(dup.statusCode).toBe(409);
  expect(dup.json()).toMatchObject({ reasonCode: "TOPUP_ALREADY_CREDITED" });
  expect((await credits(tokens.alice!)).balanceYocto).toBe((NEAR + 5n).toString());
});

it("proofs: disabled provider is 503 PROOF_PROVIDER_DISABLED", async () => {
  delete process.env.NEARESIS_OUTLAYER_LIVE;
  const r = await post(`/v1/capsules/${capId}/proofs`, tokens.alice!);
  expect(r.statusCode).toBe(503);
  expect(r.json()).toMatchObject({ reasonCode: "PROOF_PROVIDER_DISABLED" });
});

it("proofs: viewers cannot request, foreign ids are 404", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  expect((await post(`/v1/capsules/${capId}/proofs`, tokens.vera!)).statusCode).toBe(403);
  expect((await post(`/v1/capsules/nope/proofs`, tokens.alice!)).statusCode).toBe(404);
});

it("proofs: insufficient credits is 402 with required and available, and nothing is held", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  const r = await post(`/v1/capsules/${capId}/proofs`, tokens.carol!);
  expect(r.statusCode).toBe(402);
  expect(r.json()).toMatchObject({
    reasonCode: "INSUFFICIENT_CREDITS",
    requiredYocto: HOLD.toString(),
    availableYocto: "0",
  });
  expect((await credits(tokens.carol!)).heldYocto).toBe("0");
});

it("GET /v1/credits shows the hold estimate when enabled", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  expect((await credits(tokens.alice!)).proofEstimateYocto).toBe(
    (1_500_100_000_000_000_000_000n + 300_000_000_000_000n * 100_000_000n).toString(),
  );
});

it("proofs: a failure before any transaction releases the whole hold and charges nothing", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  runImpl = async () => {
    throw new Error("WASMTIME_UNAVAILABLE: no wasmtime");
  };
  const before = await credits(tokens.alice!);
  const r = await post(`/v1/capsules/${capId}/proofs`, tokens.alice!);
  expect(r.statusCode).toBe(202);
  const { proofId, state } = r.json() as { proofId: string; state: string };
  expect(state).toBe("running");
  const p = await settle(proofId, tokens.alice!);
  expect(p).toMatchObject({
    state: "failed",
    job: { txHash: null },
    cost: { heldYocto: HOLD.toString(), totalYocto: "0" },
  });
  expect(p.error).toContain("WASMTIME_UNAVAILABLE");
  const after = await credits(tokens.alice!);
  expect(after.balanceYocto).toBe(before.balanceYocto);
  expect(after.heldYocto).toBe("0");
  expect(after.entries.map((e: { kind: string }) => e.kind).slice(0, 2)).toEqual(["release", "hold"]);
  // nothing recorded as evidence: the capsule view still says not submitted
  const v = CapsuleResponseRecord.parse((await get(`/v1/capsules/${capId}`, tokens.alice!)).json());
  if (v.status !== "available") throw new Error("unavailable");
  expect(v.capsule.verification.outlayer.status).toBe("not_submitted");
});

it("proofs: a failure after the transaction charges what was burnt plus the provider charge", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  runImpl = async (o) => {
    o.live!.recordSpend!(spendEntry(hash(60)));
    throw new Error("attestation fetch failed");
  };
  const before = await credits(tokens.alice!);
  const r = await post(`/v1/capsules/${capId}/proofs`, tokens.alice!);
  const p = await settle((r.json() as { proofId: string }).proofId, tokens.alice!);
  const total = 1_051_000_300_000_000_000_000n + 1_635_944_140_488_800_000_000n;
  expect(p).toMatchObject({
    state: "failed",
    job: {
      txHash: hash(60),
      requestId: "31106",
      explorerUrl: `https://testnet.nearblocks.io/txns/${hash(60)}`,
    },
    cost: {
      chargedYocto: "1051000300000000000000",
      gasYocto: "1635944140488800000000",
      totalYocto: total.toString(),
    },
  });
  const after = await credits(tokens.alice!);
  expect(BigInt(after.balanceYocto)).toBe(BigInt(before.balanceYocto) - total);
  expect(after.heldYocto).toBe("0");
  expect(after.entries[0]).toMatchObject({ kind: "release", amountYocto: (HOLD - total).toString() });
  expect(after.entries[1]).toMatchObject({
    kind: "charge",
    amountYocto: total.toString(),
    refKind: "proof",
    refId: p.proofId,
  });
  expect(after.entries[1].detail).toMatchObject({
    txHash: hash(60),
    requestId: "31106",
    chargedYocto: "1051000300000000000000",
    tokensBurntYocto: "1635944140488800000000",
  });
  // a failed job that reached the chain is evidence of a failure in the capsule view
  const v = CapsuleResponseRecord.parse((await get(`/v1/capsules/${capId}`, tokens.alice!)).json());
  if (v.status !== "available") throw new Error("unavailable");
  expect(v.capsule.verification.outlayer.status).toBe("failed");
  // the global cap file was appended to by the recordSpend hook
  const j = JSON.parse(readFileSync(spendFile, "utf8")) as {
    entries: Array<{ txHash: string; spentTotalYocto: string }>;
  };
  expect(j.entries.at(-1)).toMatchObject({ txHash: hash(60), spentTotalYocto: "1000000000000000000000" });
});

it("proofs: a rejected attestation is not_attested but still charged", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  runImpl = async (o) => {
    o.live!.recordSpend!(spendEntry(hash(61)));
    return doc({ attested: false, txHash: hash(61) });
  };
  const r = await post(`/v1/capsules/${capId}/proofs`, tokens.alice!);
  const p = await settle((r.json() as { proofId: string }).proofId, tokens.alice!);
  expect(p).toMatchObject({
    state: "not_attested",
    verification: { decision: "reject", reasons: ["X"], collateralChecked: false },
  });
  expect(p.cost.totalYocto).toBe(
    (1_051_000_300_000_000_000_000n + 1_635_944_140_488_800_000_000n).toString(),
  );
});

it("proofs: success charges chargedYocto + tokensBurntYocto exactly and the capsule view becomes verified", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  runImpl = async (o) => {
    o.live!.recordSpend!(spendEntry(TX));
    return doc();
  };
  const before = await credits(tokens.alice!);
  const r = await post(
    `/v1/capsules/${capId}/proofs`,
    tokens.alice!,
    {},
    { "idempotency-key": "proof-key-0001" },
  );
  expect(r.statusCode).toBe(202);
  const { proofId } = r.json() as { proofId: string };
  const p = await settle(proofId, tokens.alice!);
  const total = 1_051_000_300_000_000_000_000n + 1_635_944_140_488_800_000_000n;
  expect(p).toMatchObject({
    state: "verified",
    capsuleId: capId,
    requestedBy: aliceId,
    job: { network: "testnet", requestId: "31106", txHash: TX },
    outputSha256: "ab".repeat(32),
    verification: { decision: "accept", mrTd: "11", rtmr3: "22", collateralChecked: false },
    cost: {
      heldYocto: HOLD.toString(),
      chargedYocto: "1051000300000000000000",
      gasYocto: "1635944140488800000000",
      totalYocto: total.toString(),
    },
    error: null,
  });
  expect(p.finishedAt).not.toBeNull();
  const after = await credits(tokens.alice!);
  expect(BigInt(after.balanceYocto)).toBe(BigInt(before.balanceYocto) - total);
  // replay with the same key returns the same proof and takes no second hold
  const again = await post(
    `/v1/capsules/${capId}/proofs`,
    tokens.alice!,
    {},
    { "idempotency-key": "proof-key-0001" },
  );
  expect(again.json()).toMatchObject({ proofId, state: "verified", replayed: true });
  expect((await credits(tokens.alice!)).balanceYocto).toBe(after.balanceYocto);
  // list and view
  const list = (await get(`/v1/capsules/${capId}/proofs`, tokens.alice!)).json() as {
    items: Array<{ proofId: string; state: string }>;
  };
  expect(list.items[0]).toMatchObject({ proofId, state: "verified" });
  expect(list.items.length).toBeGreaterThanOrEqual(4);
  const v = CapsuleResponseRecord.parse((await get(`/v1/capsules/${capId}`, tokens.alice!)).json());
  if (v.status !== "available") throw new Error("unavailable");
  expect(v.capsule.verification.outlayer).toMatchObject({ status: "verified", jobId: "31106" });
  expect(v.capsule.verification.outlayer.detail).toContain("Intel collateral (TCB status) was not checked");
  expect(v.capsule.verification.local.status).toBe("reproduced");
  // a second proof is refused with the existing one
  const dup = await post(`/v1/capsules/${capId}/proofs`, tokens.alice!);
  expect(dup.statusCode).toBe(409);
  expect(dup.json()).toMatchObject({ reasonCode: "ALREADY_PROVED", proof: { proofId } });
  // other workspace members can read it; unknown proof ids are 404
  expect((await get(`/v1/proofs/${proofId}`, tokens.carol!)).statusCode).toBe(200);
  expect((await get(`/v1/proofs/00000000-0000-4000-8000-000000000000`, tokens.alice!)).statusCode).toBe(404);
});

it("proofs: the global testnet cap refuses before any hold", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  const c2 = join(dir, "capsules", "cap-synthetic-2026-11-10-b");
  cpSync(join(dir, "capsules", capId), c2, { recursive: true });
  const m = JSON.parse(readFileSync(join(c2, "manifest.json"), "utf8"));
  m.capsuleId = "cap-capped";
  writeFileSync(join(c2, "manifest.json"), JSON.stringify(m));
  writeCapsuleOwnership(c2, { orgId, workspaceId: ws });
  writeSpend("1000000000000000000000"); // cap below the hold estimate
  const before = await credits(tokens.alice!);
  const r = await post(`/v1/capsules/cap-capped/proofs`, tokens.alice!);
  writeSpend(NEAR.toString());
  expect(r.statusCode).toBe(409);
  expect(r.json()).toMatchObject({ reasonCode: "TESTNET_CAP_REACHED" });
  expect((await credits(tokens.alice!)).heldYocto).toBe(before.heldYocto);
});

it("restart recovery: no tx hash releases the hold; with a tx hash it stays held and needs reconciliation", async () => {
  const svc = new CreditsService(f.db.app);
  const ctx = { orgId, userId: aliceId };
  await svc.topup(ctx, 2n * NEAR, { txHash: hash(70), signerAccountId: ALICE, receiverAccountId: DEPOSIT });
  const before = await svc.account(ctx);
  const ids = ["a", "b"].map((_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
  for (const [i, id] of ids.entries()) {
    await svc.hold(ctx, 100n, { refKind: "proof", refId: id });
    await f.db.admin.query(
      `INSERT INTO outlayer_proofs(id, org_id, workspace_id, capsule_id, requested_by, state, wasm_sha256, input_sha256, held_yocto, tx_hash)
       VALUES ($1,$2,$3,$4,$5,'running','w','i',100,$6)`,
      [id, orgId, ws, `cap-recover-${i}`, aliceId, i === 1 ? hash(71) : null],
    );
  }
  expect(await recoverInterruptedProofs(f.db.app)).toBe(2);
  const rows = (
    await f.db.admin.query(
      "SELECT id, state, error, tx_hash FROM outlayer_proofs WHERE id = ANY($1) ORDER BY id",
      [ids],
    )
  ).rows;
  expect(rows[0]).toMatchObject({ state: "failed", error: "interrupted" });
  expect(rows[1]).toMatchObject({
    state: "failed",
    error: "interrupted after submission; needs reconciliation",
    tx_hash: hash(71),
  });
  const after = await svc.account(ctx);
  expect(after.heldYocto).toBe(before.heldYocto + 100n); // only the tx-less hold was released
  expect(await recoverInterruptedProofs(f.db.app)).toBe(0);
});

const REAL = "cap-live-20260603-20261111-live-organic-v2-15fe2ad62d6c";
const realProof = join(APP_ROOT, ".data", "proofs", `${REAL}.outlayer-proof.json`);
const realCapsule = join(APP_ROOT, ".data", "proofs", "_capsules", REAL);
it.skipIf(!existsSync(realProof) || !existsSync(realCapsule))(
  "the capsule view picks up an existing live proof file (verified, jobId = request id, collateral not checked)",
  async () => {
    const cdir = join(dir, "capsules", REAL);
    cpSync(realCapsule, cdir, { recursive: true });
    writeCapsuleOwnership(cdir, { orgId, workspaceId: ws });
    for (const ext of ["outlayer-proof.json", "outlayer-attestation.json"])
      cpSync(join(APP_ROOT, ".data", "proofs", `${REAL}.${ext}`), join(proofsDir, `${REAL}.${ext}`));
    expect(readManifest(cdir)?.capsuleId).toBe(REAL);
    const v = CapsuleResponseRecord.parse((await get(`/v1/capsules/${REAL}`, tokens.alice!)).json());
    if (v.status !== "available") throw new Error("unavailable");
    expect(v.capsule.verification.outlayer).toMatchObject({ status: "verified", jobId: "31106" });
    expect(v.capsule.verification.outlayer.detail).toContain("collateral");
    const list = (await get(`/v1/capsules/${REAL}/proofs`, tokens.alice!)).json() as {
      items: Array<Record<string, any>>;
    };
    expect(list.items[0]).toMatchObject({
      state: "verified",
      job: { requestId: "31106", txHash: "9bmC5uig8dt1TU4aCmef27X4oQ6aMauaoQM6WgAxkY8i" },
      cost: {
        chargedYocto: "1051000300000000000000",
        gasYocto: "1635944140488800000000",
        totalYocto: "2686944440488800000000",
      },
    });
    // a verified legacy proof also blocks a second paid proof
    process.env.NEARESIS_OUTLAYER_LIVE = "1";
    expect((await post(`/v1/capsules/${REAL}/proofs`, tokens.alice!)).json()).toMatchObject({
      reasonCode: "ALREADY_PROVED",
    });
    // tampering with the stored proof stops it counting as verified
    const p = JSON.parse(readFileSync(join(proofsDir, `${REAL}.outlayer-proof.json`), "utf8"));
    p.attestedOutputSha256 = "00".repeat(32);
    p.localOutputSha256 = "00".repeat(32);
    writeFileSync(join(proofsDir, `${REAL}.outlayer-proof.json`), JSON.stringify(p));
    const v2 = CapsuleResponseRecord.parse((await get(`/v1/capsules/${REAL}`, tokens.alice!)).json());
    if (v2.status !== "available") throw new Error("unavailable");
    expect(v2.capsule.verification.outlayer.status).not.toBe("verified");
  },
);
