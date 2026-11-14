import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProofRecord, SpendGate } from "@nearesis/contracts";
import {
  verifyOutlayerLive,
  type OutlayerAttestationRecord,
  type OutlayerLivePolicy,
} from "./attest-outlayer.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { ExecutionReceipt, OutlayerChain, ResourceLimits } from "./outlayer-chain.ts";
import { submitOutlayerJob, type OutlayerTransport } from "./outlayer-submit.ts";
import { writeCompletedProofRecord } from "./proof-record.ts";
import { runWasi } from "./wasi.ts";

/**
 * Production OutLayer proof for a capsule (ch.14, ch.20; V03, V09, V10, V11).
 *
 * The capsule's canonical verifier input is submitted to the pinned WASM on OutLayer (`request_execution`, cost-gated as
 * `outlayer_job`), the real TDX attestation is fetched from the coordinator and verified under the pinned policy, and the
 * attested output hash is cross-checked against a local wasmtime run. Two labels stay separate:
 *   - `reproduction`: "reproduced" means the local wasmtime results equal the capsule's recorded results. It says nothing
 *     about OutLayer.
 *   - `attestation`: "attested" only when a real attestation record passed `verifyOutlayerLive` AND its output hash equals
 *     the local output. Without `live`, the attestation is "not_requested" and nothing in the record claims otherwise.
 * The proof is written beside the capsule (the capsule's own hash is untouched), bound to its capsuleHash.
 */
export const PROOF_SCHEMA = "nearesis.outlayer-proof.v1";
export const DEFAULT_LIMITS: ResourceLimits = {
  max_instructions: 1_000_000_000,
  max_memory_mb: 128,
  max_execution_seconds: 5,
};
export const FASTFS_URL = (account: string, sha: string) =>
  `https://test.fastfs.io/${account}/outlayer.testnet/${sha}.wasm`;

export type ReproductionLabel = "reproduced" | "not_reproduced" | "not_run";
export type AttestationLabel = "attested" | "rejected" | "not_requested" | "pending";

export interface SpendEntry {
  at: string;
  method: string;
  txHash: string;
  depositNear: string;
  note: string;
  burntYocto: string;
  chargedYocto: string | null;
  /** Additive: lets a caller that bills the job (the API's paid proof route) record exact amounts and the request id. */
  requestId?: number;
  depositYocto?: string;
}

export interface LiveProveOptions {
  chain: OutlayerChain;
  gate?: SpendGate;
  limits?: ResourceLimits;
  /** Hard ceiling for deposit plus the fee allowance, yoctoNEAR. The job is not submitted above it. */
  budgetYocto: bigint;
  /** Allowance for gas and fees beyond the deposit when checking the budget, yoctoNEAR (default 0.001 NEAR). */
  feeAllowanceYocto?: bigint;
  attestationTimeoutMs?: number;
  /** Called with the transaction as soon as it is on chain, before polling (so a later failure still records it). */
  recordSpend?: (e: SpendEntry) => void;
  wasmUrl?: string;
  /** Verify an already-executed job (its tx hash) instead of submitting a new one. Nothing is spent. */
  resume?: { txHash: string };
}

export interface ProveOptions {
  capsuleDir: string;
  wasmPath: string;
  policy: OutlayerLivePolicy;
  /** Directory that receives `<capsuleId>.outlayer-proof.json` and the raw attestation. */
  outDir: string;
  live?: LiveProveOptions;
  now?: Date;
}

export interface OutlayerProofJob {
  network: "testnet";
  contract: string;
  account: string;
  requestId: number;
  txHash: string;
  depositYocto: string;
  limits: ResourceLimits;
  tokensBurntYocto: string;
  chargedYocto: string | null;
  instructionsUsed: number | null;
}

export interface OutlayerProofDocument {
  schema: typeof PROOF_SCHEMA;
  capsuleId: string;
  capsuleHash: string;
  createdAt: string;
  labels: { reproduction: ReproductionLabel; attestation: AttestationLabel };
  evidenceSource: "live" | null;
  wasmSha256: string;
  inputSha256: string;
  /** sha256 of the exact `input_data` string sent to the job. */
  inputDataSha256: string;
  localOutputSha256: string | null;
  /** The local wasmtime stdout (kept so the stored proof can be re-verified offline). */
  localOutput: string | null;
  /** How the worker formed `output_hash`: sha256 of the stdout ("json") or of its JSON string encoding ("text"). */
  outputEncoding: "json" | "text" | null;
  attestedOutputSha256: string | null;
  resultsSha256Recorded: string;
  job: OutlayerProofJob | null;
  verification: null | {
    decision: "accept" | "reject";
    reasons: string[];
    mrTd: string | null;
    rtmr3: string | null;
    taskHash: string;
    collateralChecked: false;
  };
  attestationFile: string | null;
  proofRecord: ProofRecord | null;
  statement: string;
}

export type ProveRefusal =
  | "CAPSULE_INPUT_MISMATCH"
  | "WASM_NOT_PINNED"
  | "WASM_NOT_ON_FASTFS"
  | "BUDGET_EXCEEDED"
  | "LOCAL_NOT_REPRODUCED"
  | "WASMTIME_UNAVAILABLE";

export class ProveRefused extends Error {
  constructor(
    readonly code: ProveRefusal,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

interface CapsuleManifestLite {
  capsuleId: string;
  capsuleHash: string;
  computation: {
    verifier: { wasmSha256: string | null };
    inputFile: { path: string; sha256: string; bytes: number };
    resultsSha256: string;
  };
}

export function loadCapsuleForProof(capsuleDir: string) {
  const m = JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")) as CapsuleManifestLite;
  const raw = readFileSync(join(capsuleDir, m.computation.inputFile.path));
  if (sha256Hex(raw) !== m.computation.inputFile.sha256)
    throw new ProveRefused("CAPSULE_INPUT_MISMATCH", "verifier input differs from the manifest hash");
  // The chain records `input_data` as the canonical JSON string: the file without its trailing newline.
  const inputData = raw.toString("utf8").replace(/\n$/, "");
  if (canonicalJson(JSON.parse(inputData)) !== inputData)
    throw new ProveRefused("CAPSULE_INPUT_MISMATCH", "verifier input is not canonical JSON");
  return { manifest: m, inputData };
}

const NEAR_YOCTO = 10n ** 24n;
/**
 * The hash the worker attests for an output. A JSON output is hashed as returned (the recorded request 29674); an output
 * the worker classed as text is hashed as its JSON string encoding (request 31106, `Output: Text(656 bytes)`). Both are
 * exact functions of the local stdout, so neither weakens the output cross-check.
 */
export const attestedOutputHash = (stdout: string, enc: "json" | "text"): string =>
  sha256Hex(enc === "json" ? stdout : JSON.stringify(stdout));

export const nearOf = (y: bigint | string): string => {
  const v = BigInt(y);
  const frac = (v % NEAR_YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / NEAR_YOCTO}${frac ? `.${frac}` : ""}`;
};

export async function proveCapsule(o: ProveOptions): Promise<OutlayerProofDocument> {
  const { manifest, inputData } = loadCapsuleForProof(o.capsuleDir);
  const wasm = readFileSync(o.wasmPath);
  const wasmSha = sha256Hex(wasm);
  if (manifest.computation.verifier.wasmSha256 !== wasmSha || !o.policy.allowedWasmSha256.includes(wasmSha))
    throw new ProveRefused(
      "WASM_NOT_PINNED",
      "the wasm is not the capsule's pinned verifier or not in the policy",
    );

  // Local wasmtime run on exactly the bytes the job receives.
  const inputBytes = Buffer.from(inputData);
  const local = runWasi(o.wasmPath, inputBytes);
  if (!local.ran && local.reason?.startsWith("wasmtime"))
    throw new ProveRefused("WASMTIME_UNAVAILABLE", local.reason);
  const reproduction: ReproductionLabel = !local.ran
    ? "not_run"
    : local.outputSha256 === manifest.computation.resultsSha256
      ? "reproduced"
      : "not_reproduced";
  const localOutputText = local.stdout.toString("utf8");
  const localOutputSha256 = local.ran ? sha256Hex(localOutputText) : null;

  const base = {
    schema: PROOF_SCHEMA,
    capsuleId: manifest.capsuleId,
    capsuleHash: manifest.capsuleHash,
    createdAt: (o.now ?? new Date()).toISOString(),
    wasmSha256: wasmSha,
    inputSha256: manifest.computation.inputFile.sha256,
    inputDataSha256: sha256Hex(inputData),
    localOutputSha256,
    localOutput: local.ran ? localOutputText : null,
    outputEncoding: null as "json" | "text" | null,
    resultsSha256Recorded: manifest.computation.resultsSha256,
  } as const;
  const write = (doc: OutlayerProofDocument) => {
    mkdirSync(o.outDir, { recursive: true });
    writeFileSync(
      join(o.outDir, `${manifest.capsuleId}.outlayer-proof.json`),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
    return doc;
  };

  if (!o.live)
    return write({
      ...base,
      labels: { reproduction, attestation: "not_requested" },
      evidenceSource: null,
      attestedOutputSha256: null,
      job: null,
      verification: null,
      attestationFile: null,
      proofRecord: null,
      statement:
        reproduction === "reproduced"
          ? "Reproduced locally under wasmtime. No OutLayer job was submitted, so this is NOT attested."
          : `Local reproduction: ${reproduction}. No OutLayer job was submitted.`,
    });
  if (reproduction !== "reproduced")
    throw new ProveRefused(
      "LOCAL_NOT_REPRODUCED",
      "the local run does not reproduce the capsule results; no job is submitted",
    );

  const live = o.live;
  const limits = live.limits ?? DEFAULT_LIMITS;
  const wasmUrl = live.wasmUrl ?? FASTFS_URL(live.chain.account, wasmSha);
  const got: { receipt: ExecutionReceipt | null; record: OutlayerAttestationRecord | null } = {
    receipt: null,
    record: null,
  };
  const timeout = live.attestationTimeoutMs ?? 180_000;
  if (live.resume) {
    // Verify a job that was already paid for: read its transaction and attestation, spend nothing.
    got.receipt = await live.chain.fetchReceipt(live.resume.txHash);
    got.record = await live.chain.fetchAttestation(got.receipt.requestId, timeout);
  } else {
    if (!(await live.chain.wasmAvailable(wasmUrl, wasmSha)))
      throw new ProveRefused("WASM_NOT_ON_FASTFS", `${wasmUrl} does not serve the pinned wasm`);
    // The contract's own quote for these limits and this input size: attaching exactly it avoids both an underpayment
    // rejection and an over-deposit that must be refunded.
    const deposit = BigInt(await live.chain.estimateDeposit(limits, Buffer.byteLength(inputData)));
    const allowance = live.feeAllowanceYocto ?? 10n ** 21n;
    if (deposit + allowance > live.budgetYocto)
      throw new ProveRefused(
        "BUDGET_EXCEEDED",
        `deposit ${nearOf(deposit)} NEAR plus ${nearOf(allowance)} fees exceeds the budget ${nearOf(live.budgetYocto)} NEAR`,
      );
    const transport: OutlayerTransport = {
      async submit() {
        const receipt = await live.chain.requestExecution(
          { wasmUrl, wasmSha256: wasmSha, inputData, limits },
          deposit.toString(),
        );
        got.receipt = receipt;
        live.recordSpend?.({
          at: new Date().toISOString(),
          method: `request_execution (outlayer.testnet) via research:prove, capsule ${manifest.capsuleId}`,
          txHash: receipt.txHash,
          depositNear: nearOf(deposit),
          note: `request ${receipt.requestId}; deposit is the contract's estimate_execution_cost`,
          burntYocto: receipt.tokensBurntYocto,
          chargedYocto: receipt.chargedYocto,
          requestId: receipt.requestId,
          depositYocto: receipt.depositYocto,
        });
        got.record = await live.chain.fetchAttestation(receipt.requestId, timeout);
        return {
          status: got.record ? "succeeded" : "failed",
          computeUnitsUsed: (receipt.instructionsUsed ?? limits.max_instructions) / 1e6,
        };
      },
    };
    await submitOutlayerJob(
      { transport, ...(live.gate ? { gate: live.gate } : {}) },
      {
        jobId: `${manifest.capsuleId}:${wasmSha.slice(0, 12)}`,
        maxComputeUnits: limits.max_instructions / 1e6,
        input: { capsuleId: manifest.capsuleId, inputDataSha256: base.inputDataSha256 },
      },
    );
  }
  const { receipt, record } = got;
  if (!receipt) throw new Error("job submitted without a receipt");
  const job: OutlayerProofJob = {
    network: "testnet",
    contract: "outlayer.testnet",
    account: live.chain.account,
    requestId: receipt.requestId,
    txHash: receipt.txHash,
    depositYocto: receipt.depositYocto,
    limits,
    tokensBurntYocto: receipt.tokensBurntYocto,
    chargedYocto: receipt.chargedYocto,
    instructionsUsed: receipt.instructionsUsed,
  };
  if (!record)
    return write({
      ...base,
      labels: { reproduction, attestation: "pending" },
      evidenceSource: null,
      attestedOutputSha256: null,
      job,
      verification: null,
      attestationFile: null,
      proofRecord: null,
      statement: `OutLayer request ${receipt.requestId} was submitted but no attestation was available before the timeout. NOT attested.`,
    });

  const attestationFile = `${manifest.capsuleId}.outlayer-attestation.json`;
  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(join(o.outDir, attestationFile), `${JSON.stringify(record, null, 2)}\n`);
  // The worker states whether it saw JSON or text; without that statement both encodings are tried (and recorded).
  const encodings: Array<"json" | "text"> = receipt.outputKind ? [receipt.outputKind] : ["json", "text"];
  const tried = encodings.map((enc) => ({
    enc,
    d: verifyOutlayerLive(record, o.policy, {
      localWasmSha256: wasmSha,
      inputData,
      expectedOutputSha256: attestedOutputHash(localOutputText, enc),
    }),
  }));
  const pick = tried.find((t) => t.d.reasons.length === 0) ?? tried[0]!;
  const d = pick.d;
  const reasons = [...d.reasons];
  // The record must belong to the job this process submitted.
  if (record.request_id !== receipt.requestId) reasons.push("ATTESTATION_REQUEST_ID_MISMATCH");
  if (record.transaction_hash !== receipt.txHash) reasons.push("ATTESTATION_TX_MISMATCH");
  if (record.caller_account_id !== live.chain.account) reasons.push("ATTESTATION_CALLER_MISMATCH");
  const accepted = reasons.length === 0;
  const proofRecord = accepted
    ? writeCompletedProofRecord({
        evidenceSource: "live",
        sourceArtifact: readFileSync(join(o.capsuleDir, "manifest.json")),
        inputs: { path: manifest.computation.inputFile.path, bytes: inputBytes },
        wasm,
        output: Buffer.from(localOutputText),
        approvedMeasurements: o.policy.allowedMeasurements,
        quote: { measurement: d.mrTd ?? "" },
        jobId: `outlayer-testnet-request-${receipt.requestId}`,
      })
    : null;
  return write({
    ...base,
    labels: { reproduction, attestation: accepted ? "attested" : "rejected" },
    evidenceSource: accepted ? "live" : null,
    attestedOutputSha256: record.output_hash,
    outputEncoding: accepted ? pick.enc : null,
    job,
    verification: {
      decision: accepted ? "accept" : "reject",
      reasons,
      mrTd: d.mrTd,
      rtmr3: d.rtmr3,
      taskHash: d.taskHash,
      collateralChecked: false,
    },
    attestationFile,
    proofRecord,
    statement: accepted
      ? `Attested: OutLayer testnet request ${receipt.requestId} (tx ${receipt.txHash}) returned a TDX attestation that verified under the pinned policy, and its output hash equals the local wasmtime output. Intel PCS collateral was not checked.`
      : `Attestation REJECTED (${reasons.join(", ")}). Local reproduction: ${reproduction}. No attested badge.`,
  });
}

export interface StoredProofCheck {
  ok: boolean;
  reasons: string[];
}

/** Re-verifies a stored proof offline: capsule hash binding, the saved attestation under the supplied policy, labels. */
export function verifyStoredOutlayerProof(
  proofPath: string,
  capsuleDir: string,
  policy: OutlayerLivePolicy,
): StoredProofCheck {
  const reasons: string[] = [];
  const doc = JSON.parse(readFileSync(proofPath, "utf8")) as OutlayerProofDocument;
  const { manifest, inputData } = loadCapsuleForProof(capsuleDir);
  if (doc.capsuleHash !== manifest.capsuleHash) reasons.push("CAPSULE_HASH_MISMATCH");
  if (doc.inputDataSha256 !== sha256Hex(inputData)) reasons.push("INPUT_MISMATCH");
  if (doc.labels.attestation === "attested") {
    if (!doc.attestationFile || !doc.job)
      return { ok: false, reasons: [...reasons, "ATTESTED_WITHOUT_EVIDENCE"] };
    const rec = JSON.parse(
      readFileSync(join(proofPath, "..", doc.attestationFile), "utf8"),
    ) as OutlayerAttestationRecord;
    if (
      doc.localOutput === null ||
      doc.outputEncoding === null ||
      sha256Hex(doc.localOutput) !== doc.localOutputSha256
    )
      reasons.push("ATTESTED_WITHOUT_LOCAL_OUTPUT");
    else {
      const d = verifyOutlayerLive(rec, policy, {
        localWasmSha256: doc.wasmSha256,
        inputData,
        expectedOutputSha256: attestedOutputHash(doc.localOutput, doc.outputEncoding),
      });
      reasons.push(...d.reasons);
    }
    if (doc.labels.reproduction !== "reproduced") reasons.push("ATTESTED_BUT_NOT_REPRODUCED");
  } else if (doc.verification?.decision === "accept") reasons.push("ACCEPT_WITHOUT_ATTESTED_LABEL");
  return { ok: reasons.length === 0, reasons };
}
