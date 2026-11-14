import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CapsuleViewRecord } from "@nearesis/contracts";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  APP_ROOT,
  loadOutlayerLivePolicy,
  readManifest,
  verifyStoredOutlayerProof,
  type OutlayerProofDocument,
} from "@nearesis/capsule";

export type ProofState = "running" | "verified" | "not_attested" | "failed";

export interface ProofRow {
  id: string;
  workspace_id: string;
  capsule_id: string;
  requested_by: string;
  state: ProofState;
  request_id: string | null;
  tx_hash: string | null;
  wasm_sha256: string;
  input_sha256: string;
  output_sha256: string | null;
  decision: "accept" | "reject" | null;
  reasons: string[];
  mr_td: string | null;
  rtmr3: string | null;
  held_yocto: string;
  charged_yocto: string | null;
  gas_yocto: string | null;
  total_yocto: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface Proof {
  proofId: string;
  capsuleId: string;
  state: ProofState;
  requestedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  job: { network: "testnet"; requestId: string | null; txHash: string | null; explorerUrl: string | null };
  wasmSha256: string;
  inputSha256: string;
  outputSha256: string | null;
  verification: {
    decision: "accept" | "reject" | null;
    reasons: string[];
    mrTd: string | null;
    rtmr3: string | null;
    collateralChecked: false;
  };
  cost: {
    heldYocto: string | null;
    chargedYocto: string | null;
    gasYocto: string | null;
    totalYocto: string | null;
  };
  error: string | null;
}

export const PROOF_COLUMNS =
  "id, workspace_id, capsule_id, requested_by, state, request_id, tx_hash, wasm_sha256, input_sha256, output_sha256, decision, reasons, mr_td, rtmr3, held_yocto, charged_yocto, gas_yocto, total_yocto, error, created_at, finished_at";

const explorer = (h: string | null) => (h ? `https://testnet.nearblocks.io/txns/${h}` : null);

export function rowToProof(r: ProofRow): Proof {
  return {
    proofId: r.id,
    capsuleId: r.capsule_id,
    state: r.state,
    requestedBy: r.requested_by,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    job: { network: "testnet", requestId: r.request_id, txHash: r.tx_hash, explorerUrl: explorer(r.tx_hash) },
    wasmSha256: r.wasm_sha256,
    inputSha256: r.input_sha256,
    outputSha256: r.output_sha256,
    verification: {
      decision: r.decision,
      reasons: r.reasons,
      mrTd: r.mr_td,
      rtmr3: r.rtmr3,
      collateralChecked: false,
    },
    cost: {
      heldYocto: r.held_yocto,
      chargedYocto: r.charged_yocto,
      gasYocto: r.gas_yocto,
      totalYocto: r.total_yocto,
    },
    error: r.error,
  };
}

export const proofDir = (): string => process.env.NEARESIS_PROOF_DIR ?? join(APP_ROOT, ".data", "proofs");
export const legacyProofId = (capsuleId: string) => `file-${capsuleId}`;

export interface FileProof {
  proof: Proof;
  /** True when the stored proof is live, accepted, attested and re-verified offline under the pinned policy. */
  verified: boolean;
  requestId: number | null;
  recheck: string[];
}

const fileCache = new Map<string, { key: string; value: FileProof | null }>();

/**
 * The stored `<capsuleId>.outlayer-proof.json` of an earlier live job (written by `research:prove --live`). It counts as
 * verified only when it is bound to this capsule, evidenceSource is live, the decision is accept and the saved TDX
 * attestation re-verifies offline under the pinned policy. Anything else is reported as not attested.
 */
export function readFileProof(capsuleDir: string, capsuleId: string, capsuleHash: string): FileProof | null {
  const path = join(proofDir(), `${capsuleId}.outlayer-proof.json`);
  if (!existsSync(path)) return null;
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}:${capsuleHash}`;
  } catch {
    return null;
  }
  const hit = fileCache.get(path);
  if (hit?.key === key) return hit.value;
  let value: FileProof | null = null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as OutlayerProofDocument;
    if (doc.schema === "nearesis.outlayer-proof.v1" && doc.capsuleId === capsuleId && doc.job) {
      const live = doc.evidenceSource === "live" && doc.verification?.decision === "accept";
      let recheck: string[] = [];
      if (live && doc.capsuleHash === capsuleHash) {
        try {
          const c = verifyStoredOutlayerProof(path, capsuleDir, loadOutlayerLivePolicy());
          recheck = c.ok ? [] : c.reasons;
        } catch (e) {
          recheck = [`STORED_PROOF_UNREADABLE: ${(e as Error).message.slice(0, 120)}`];
        }
      } else if (live) recheck = ["CAPSULE_HASH_MISMATCH"];
      const verified = live && recheck.length === 0 && doc.labels.attestation === "attested";
      const charged = doc.job.chargedYocto;
      const burnt = doc.job.tokensBurntYocto;
      value = {
        verified,
        requestId: doc.job.requestId,
        recheck,
        proof: {
          proofId: legacyProofId(capsuleId),
          capsuleId,
          state: verified ? "verified" : "not_attested",
          requestedBy: null,
          createdAt: doc.createdAt,
          finishedAt: doc.createdAt,
          job: {
            network: "testnet",
            requestId: String(doc.job.requestId),
            txHash: doc.job.txHash,
            explorerUrl: explorer(doc.job.txHash),
          },
          wasmSha256: doc.wasmSha256,
          inputSha256: doc.inputSha256,
          outputSha256: doc.attestedOutputSha256,
          verification: {
            decision: doc.verification?.decision ?? null,
            reasons: [...(doc.verification?.reasons ?? []), ...recheck],
            mrTd: doc.verification?.mrTd ?? null,
            rtmr3: doc.verification?.rtmr3 ?? null,
            collateralChecked: false,
          },
          cost: {
            heldYocto: null,
            chargedYocto: charged,
            gasYocto: burnt,
            totalYocto: charged !== null && burnt ? (BigInt(charged) + BigInt(burnt)).toString() : null,
          },
          error: null,
        },
      };
    }
  } catch {
    value = null;
  }
  fileCache.set(path, { key, value });
  return value;
}

const METHOD = "OutLayer TEE attestation (TDX quote checked under the pinned policy)";
const NO_COLLATERAL = "Intel collateral (TCB status) was not checked.";

type Outlayer = CapsuleViewRecord["verification"]["outlayer"];

function fromProof(p: Proof): Outlayer | null {
  const at = p.finishedAt ?? p.createdAt;
  const tx = p.job.txHash ? ` Transaction ${p.job.txHash}.` : "";
  if (p.state === "verified")
    return {
      status: "verified",
      method: METHOD,
      jobId: p.job.requestId,
      checkedAt: at,
      detail:
        `OutLayer testnet request ${p.job.requestId}: attestation accepted, output hash equals the local run.${tx} ${NO_COLLATERAL}`.slice(
          0,
          480,
        ),
    };
  if (p.state === "running")
    return {
      status: "unverified",
      method: METHOD,
      jobId: p.job.requestId,
      checkedAt: null,
      detail: "An OutLayer proof job is running; nothing is verified yet.",
    };
  if (p.state === "not_attested")
    return {
      status: p.verification.decision === "reject" ? "failed" : "unverified",
      method: METHOD,
      jobId: p.job.requestId,
      checkedAt: at,
      detail: (p.verification.decision === "reject"
        ? `Attestation rejected: ${p.verification.reasons.join(", ")}.${tx}`
        : `The job ran but no accepted attestation is available.${tx} ${p.verification.reasons.join(", ")}`
      ).slice(0, 480),
    };
  // failed: only a job that reached the chain is evidence of anything; a refusal before any transaction changes nothing
  if (!p.job.txHash) return null;
  return {
    status: "failed",
    method: METHOD,
    jobId: p.job.requestId,
    checkedAt: at,
    detail: `The OutLayer job failed after submission (${p.error ?? "unknown error"}).${tx}`.slice(0, 480),
  };
}

/**
 * Applies the newest proof record to the capsule view's `outlayer` field: the newest table record that is evidence of
 * something, else the stored proof file. The local status is never touched, and an already verified embedded
 * attestation is never downgraded.
 */
export function applyProofToView(
  view: CapsuleViewRecord,
  rows: Proof[],
  file: FileProof | null,
): CapsuleViewRecord {
  const candidates: Proof[] = [...rows];
  if (file) candidates.push(file.proof);
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const c of candidates) {
    const o = fromProof(c);
    if (!o) continue;
    if (view.verification.outlayer.status === "verified" && o.status !== "verified") return view;
    return { ...view, verification: { ...view.verification, outlayer: o } };
  }
  return view;
}

/** Capsule view with the newest proof record applied (table first, then the stored proof file). */
export async function overlayProofs(
  kernel: Kernel,
  s: Session,
  capsuleDir: string,
  view: CapsuleViewRecord,
): Promise<CapsuleViewRecord> {
  const rows = await kernel.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
    const r = await tx.query<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM outlayer_proofs WHERE capsule_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [view.capsuleId],
    );
    return r.rows;
  });
  const m = readManifest(capsuleDir);
  return applyProofToView(
    view,
    rows.map(rowToProof),
    m ? readFileProof(capsuleDir, view.capsuleId, m.capsuleHash) : null,
  );
}
