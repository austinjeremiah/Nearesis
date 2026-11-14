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
import { UsdCreditsService, yoctoToMicroUsd, microToUsd } from "@nearesis/kernel";
import { recoverInterruptedProofs } from "../src/proof-routes.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const NEAR = 10n ** 24n;
const DEPOSIT = "majorlynx5104.testnet";
const ALICE = "alice.testnet";
const HOLD = 1_500_100_000_000_000_000_000n + 300_000_000_000_000n * 100_000_000n; // estimate + 300 Tgas at 1e8
const RATE = { rate: "3.5", date: "2026-11-13" };
const usdMicro = (v: string) => BigInt(v.replace(".", ""));
const usd = (yocto: bigint) => microToUsd(yoctoToMicroUsd(yocto, RATE.rate));
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
let carolId: string;
let ws: string;
const tokens: Record<string, string> = {};
let rateImpl: () => Promise<{ rate: string; date: string } | null> = async () => RATE;
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
      nearUsdRate: () => rateImpl(),
      credits: {
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
  carolId = org.users.carol!.userId;
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

it("GET /v1/credits grants the USD 3 allowance on first use and has no estimate while proofs are disabled", async () => {
  const c = await credits(tokens.alice!);
  expect(c).toMatchObject({
    allowanceUsd: "3.000000",
    spentUsd: "0.000000",
    heldUsd: "0.000000",
    availableUsd: "3.000000",
    exhausted: false,
    contactEmail: "connect@kaushikh.xyz",
    byCategory: { modelUsd: "0.000000", outlayerUsd: "0.000000", anchorUsd: "0.000000" },
    nearUsdRate: RATE,
    proofEstimateUsd: null,
  });
  expect(c.entries).toHaveLength(1);
  expect(c.entries[0]).toMatchObject({ kind: "grant", category: "grant", amountUsd: "3.000000" });
  expect(c).not.toHaveProperty("depositAccount");
  expect(c).not.toHaveProperty("balanceYocto");
  // a second read grants nothing more
  expect((await credits(tokens.alice!)).entries).toHaveLength(1);
});

it("GET /v1/credits has a null rate when no NEAR/USD close is held", async () => {
  rateImpl = async () => null;
  try {
    expect((await credits(tokens.alice!)).nearUsdRate).toBeNull();
  } finally {
    rateImpl = async () => RATE;
  }
});

it("POST /v1/credits/topups is gone (404)", async () => {
  expect((await post("/v1/credits/topups", tokens.alice!, { txHash: hash(1) })).statusCode).toBe(404);
});

it("GET /v1/me carries the credits summary", async () => {
  const me = (await get("/v1/me", tokens.alice!)).json() as Record<string, any>;
  expect(me.credits).toEqual({ availableUsd: "3.000000", allowanceUsd: "3.000000", exhausted: false });
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

it("proofs: exhausted credits is 402 CREDITS_EXHAUSTED with the contact details, and nothing is held", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  const svc = new UsdCreditsService(f.db.app);
  await svc.charge({ orgId, userId: carolId }, 3_000_000n, {
    refKind: "run",
    refId: "spent",
    category: "model",
  });
  const r = await post(`/v1/capsules/${capId}/proofs`, tokens.carol!);
  expect(r.statusCode).toBe(402);
  expect(r.json()).toMatchObject({
    errorCode: "BUDGET_EXCEEDED",
    reasonCode: "CREDITS_EXHAUSTED",
    message: "You have used your credits. Write to connect@kaushikh.xyz to request more access.",
    details: {
      allowanceUsd: "3.000000",
      spentUsd: "3.000000",
      availableUsd: "0.000000",
      requiredUsd: usd(HOLD),
      contactEmail: "connect@kaushikh.xyz",
    },
  });
  const c = await credits(tokens.carol!);
  expect(c).toMatchObject({ heldUsd: "0.000000", exhausted: true, byCategory: { modelUsd: "3.000000" } });
});

it("proofs: no NEAR/USD close is 503 PRICE_UNAVAILABLE, nothing is held and no rate is guessed", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  rateImpl = async () => null;
  try {
    const r = await post(`/v1/capsules/${capId}/proofs`, tokens.alice!);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ reasonCode: "PRICE_UNAVAILABLE" });
    const c = await credits(tokens.alice!);
    expect(c.heldUsd).toBe("0.000000");
    expect(c.proofEstimateUsd).toBeNull();
  } finally {
    rateImpl = async () => RATE;
  }
});

it("GET /v1/credits shows the hold estimate in USD when enabled", async () => {
  process.env.NEARESIS_OUTLAYER_LIVE = "1";
  expect((await credits(tokens.alice!)).proofEstimateUsd).toBe(usd(HOLD));
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
    cost: { heldYocto: HOLD.toString(), heldUsd: usd(HOLD), totalYocto: "0", totalUsd: "0.000000" },
  });
  expect(p.error).toContain("WASMTIME_UNAVAILABLE");
  const after = await credits(tokens.alice!);
  expect(after.spentUsd).toBe(before.spentUsd);
  expect(after.availableUsd).toBe(before.availableUsd);
  expect(after.heldUsd).toBe("0.000000");
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
      chargedUsd: usd(1_051_000_300_000_000_000_000n),
      gasUsd: usd(1_635_944_140_488_800_000_000n),
      totalUsd: usd(total),
      heldUsd: usd(HOLD),
      nearUsdRate: "3.5",
      rateDate: "2026-11-13",
    },
  });
  const after = await credits(tokens.alice!);
  const totalMicro = yoctoToMicroUsd(total, RATE.rate);
  expect(usdMicro(after.spentUsd) - usdMicro(before.spentUsd)).toBe(totalMicro);
  expect(after.heldUsd).toBe("0.000000");
  expect(after.byCategory.outlayerUsd).toBe(after.spentUsd);
  expect(after.entries[0]).toMatchObject({
    kind: "release",
    amountUsd: microToUsd(yoctoToMicroUsd(HOLD, RATE.rate) - totalMicro),
  });
  expect(after.entries[1]).toMatchObject({
    kind: "charge",
    category: "outlayer",
    amountUsd: usd(total),
    refKind: "proof",
    refId: p.proofId,
  });
  expect(after.entries[1].detail).toMatchObject({
    txHash: hash(60),
    requestId: "31106",
    chargedYocto: "1051000300000000000000",
    tokensBurntYocto: "1635944140488800000000",
    nearUsdRate: "3.5",
    rateDate: "2026-11-13",
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

it("proofs: success charges (chargedYocto + tokensBurntYocto) x the recorded rate exactly and the capsule view becomes verified", async () => {
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
      heldUsd: usd(HOLD),
      totalUsd: usd(total),
      nearUsdRate: "3.5",
      rateDate: "2026-11-13",
    },
    error: null,
  });
  expect(p.finishedAt).not.toBeNull();
  const after = await credits(tokens.alice!);
  expect(usdMicro(after.spentUsd) - usdMicro(before.spentUsd)).toBe(yoctoToMicroUsd(total, RATE.rate));
  // replay with the same key returns the same proof and takes no second hold
  const again = await post(
    `/v1/capsules/${capId}/proofs`,
    tokens.alice!,
    {},
    { "idempotency-key": "proof-key-0001" },
  );
  expect(again.json()).toMatchObject({ proofId, state: "verified", replayed: true });
  expect((await credits(tokens.alice!)).spentUsd).toBe(after.spentUsd);
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
  expect((await credits(tokens.alice!)).heldUsd).toBe(before.heldUsd);
});

it("restart recovery: no tx hash releases the hold; with a tx hash it stays held and needs reconciliation", async () => {
  const svc = new UsdCreditsService(f.db.app);
  const ctx = { orgId, userId: aliceId };
  const before = await svc.account(ctx);
  const ids = ["a", "b"].map((_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
  for (const [i, id] of ids.entries()) {
    await svc.hold(ctx, 100n, { refKind: "proof", refId: id, category: "outlayer" });
    await f.db.admin.query(
      `INSERT INTO outlayer_proofs(id, org_id, workspace_id, capsule_id, requested_by, state, wasm_sha256, input_sha256, held_yocto, held_micro, tx_hash)
       VALUES ($1,$2,$3,$4,$5,'running','w','i',100,100,$6)`,
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
  expect(after.heldMicro).toBe(before.heldMicro + 100n); // only the tx-less hold was released
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
        // a proof file of the earlier live job predates user credits: the exact NEAR amounts, no USD charge
        chargedYocto: "1051000300000000000000",
        gasYocto: "1635944140488800000000",
        totalYocto: "2686944440488800000000",
        chargedUsd: null,
        totalUsd: null,
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
