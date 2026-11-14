import { createHash } from "node:crypto";
import { verifyTdxQuote, type TdxVerification } from "./tdx.ts";

/**
 * Verification of a REAL OutLayer attestation as served by the public coordinator (`/attestations/by-request/<id>`).
 * This is a separate path from `verifyAttestation` (which models an ed25519 TEE signer) because a real OutLayer record is
 * bound differently: the TDX quote's reportData[0..32] commits to a "task hash" over the record's own fields.
 * Binding layout confirmed against a live testnet job (request 21428): V1 shape, task_type, task_id (i64 LE), build_target,
 * wasm_hash, input_hash, output_hash, block_height (u64 LE), caller_account_id, timestamp (i64 LE), attached_usd if set.
 *
 * Fails closed: every condition must hold. `collateralChecked` is always false (no Intel PCS collateral: TCB level, QE
 * identity and CRLs are not checked), and the result says so.
 */
export interface OutlayerAttestationRecord {
  task_type: string;
  task_id: number;
  tdx_quote: string;
  worker_measurement: string;
  request_id: number;
  caller_account_id: string;
  transaction_hash: string;
  block_height: number;
  build_target: string;
  wasm_hash: string;
  executed_wasm_sha256?: string;
  input_hash: string;
  output_hash: string;
  attached_usd?: string | null;
  timestamp: number;
}

export interface OutlayerLivePolicy {
  allowedWasmSha256: string[];
  allowedMeasurements: string[]; // MRTD, 96 hex
  quoteTrustRootSha256: string[];
}

export interface OutlayerLiveExpect {
  localWasmSha256: string;
  /** The exact input string the chain recorded as `input_data` in the execution_requested event. */
  inputData: string;
  expectedOutputSha256: string;
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export function outlayerTaskHash(a: OutlayerAttestationRecord): string {
  const i64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    return b;
  };
  const u64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const s = (v: string) => Buffer.from(v);
  return sha(
    Buffer.concat([
      s(a.task_type),
      i64(a.task_id),
      s(a.build_target),
      s(a.wasm_hash),
      s(a.input_hash),
      s(a.output_hash),
      u64(a.block_height),
      s(a.caller_account_id),
      i64(a.timestamp),
      ...(a.attached_usd ? [s(a.attached_usd)] : []),
    ]),
  );
}

export interface OutlayerLiveDecision {
  decision: "accept" | "reject";
  reasons: string[];
  evidenceSource: "live" | "fixture";
  collateralChecked: false;
  mrTd: string | null;
  rtmr3: string | null;
  taskHash: string;
}

export function verifyOutlayerLive(
  rec: OutlayerAttestationRecord,
  policy: OutlayerLivePolicy,
  expect: OutlayerLiveExpect,
): OutlayerLiveDecision {
  const reasons: string[] = [];
  const q: TdxVerification = verifyTdxQuote(rec.tdx_quote, {
    trustedRootSha256: policy.quoteTrustRootSha256,
  });
  const taskHash = outlayerTaskHash(rec);
  let mrTd: string | null = null;
  let rtmr3: string | null = null;
  if (!q.ok) reasons.push(q.reason);
  else {
    mrTd = q.fields.mrTd;
    rtmr3 = q.fields.rtmr[3] ?? null;
    if (q.fields.debug) reasons.push("QUOTE_DEBUG_MODE");
    if (!policy.allowedMeasurements.includes(q.fields.mrTd)) reasons.push("MEASUREMENT_NOT_ALLOWED");
    if (rtmr3 !== rec.worker_measurement) reasons.push("WORKER_MEASUREMENT_MISMATCH");
    if (q.fields.reportData.slice(0, 64) !== taskHash) reasons.push("RESPONSE_BINDING_MISMATCH");
  }
  if (!policy.allowedWasmSha256.includes(rec.wasm_hash)) reasons.push("WASM_HASH_NOT_ALLOWED");
  if (rec.wasm_hash !== expect.localWasmSha256 || rec.executed_wasm_sha256 !== expect.localWasmSha256)
    reasons.push("WASM_HASH_MISMATCH");
  if (rec.input_hash !== sha(expect.inputData)) reasons.push("INPUT_HASH_MISMATCH");
  if (rec.output_hash !== expect.expectedOutputSha256) reasons.push("OUTPUT_HASH_MISMATCH");
  const ok = reasons.length === 0;
  return {
    decision: ok ? "accept" : "reject",
    reasons,
    evidenceSource: ok ? "live" : "fixture",
    collateralChecked: false,
    mrTd,
    rtmr3,
    taskHash,
  };
}
