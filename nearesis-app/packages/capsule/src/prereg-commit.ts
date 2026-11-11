import { canonicalDocHash } from "./prereg-readback.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * Preregistration commitment (V13): decision logic for committing only the canonical hash of the preregistration
 * before the lockbox opens, readback, replay defence and ordering.
 *
 * No chain is written by this module. `SimulatedChain` is a deterministic in-memory ledger used for the FIXTURE half; its
 * receipts say `network: "sandbox-simulated"` and can never establish the testnet claim. A testnet or mainnet adapter would
 * implement the same `ChainAdapter` interface and needs a signed transaction, which no agent run may create (BLK-20261110-003).
 */
export interface CommitPayload {
  kind: "nearesis.prereg.v1";
  hash: string;
  experimentId?: string;
}
export interface ChainTx {
  signer: string;
  nonce: number;
  payload: unknown;
}
export interface Receipt {
  txHash: string;
  blockHeight: number;
  signer: string;
  network: string;
  confirmed: boolean;
}
export type SubmitResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; code: "REPLAY_REJECTED" | "PAYLOAD_NOT_HASH_ONLY"; detail: string };
export interface ChainAdapter {
  readonly network: string;
  /** Finality is modelled as a block-height lag the adapter reports; `read` only returns confirmed transactions. */
  submit(tx: ChainTx): SubmitResult;
  read(txHash: string): { payload: unknown; receipt: Receipt } | null;
}

const ALLOWED_KEYS = new Set(["kind", "hash", "experimentId"]);
const HEX64 = /^[0-9a-f]{64}$/;

/** Hash only, plus the allowed metadata. The raw document, or any other field, is refused. */
export function validateCommitPayload(p: unknown): { ok: true } | { ok: false; detail: string } {
  if (typeof p !== "object" || p === null || Array.isArray(p))
    return { ok: false, detail: "payload is not an object" };
  const o = p as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0)
    return { ok: false, detail: `fields beyond the hash and allowed metadata: ${extra.join(", ")}` };
  if (o.kind !== "nearesis.prereg.v1") return { ok: false, detail: "unknown payload kind" };
  if (typeof o.hash !== "string" || !HEX64.test(o.hash))
    return { ok: false, detail: "hash is not a SHA-256 hex digest" };
  if (o.experimentId !== undefined && (typeof o.experimentId !== "string" || o.experimentId.length > 120))
    return { ok: false, detail: "experimentId is not a short string" };
  return { ok: true };
}

export class SimulatedChain implements ChainAdapter {
  readonly network = "sandbox-simulated";
  private height = 100;
  private readonly seen = new Map<string, { payload: unknown; receipt: Receipt }>();
  /** Number of state-changing effects. A replay must not increase it. */
  effects = 0;
  constructor(private readonly finalityBlocks = 2) {}

  submit(tx: ChainTx): SubmitResult {
    const v = validateCommitPayload(tx.payload);
    if (!v.ok) return { ok: false, code: "PAYLOAD_NOT_HASH_ONLY", detail: v.detail };
    const txHash = sha256Hex(canonicalJson(tx));
    if (this.seen.has(txHash))
      return { ok: false, code: "REPLAY_REJECTED", detail: "transaction already applied" };
    this.height += 1;
    const receipt: Receipt = {
      txHash,
      blockHeight: this.height,
      signer: tx.signer,
      network: this.network,
      confirmed: false,
    };
    this.seen.set(txHash, { payload: tx.payload, receipt });
    this.effects += 1;
    return { ok: true, receipt };
  }
  /** Produce blocks until the receipt is final. */
  advance(blocks = this.finalityBlocks): void {
    this.height += blocks;
  }
  read(txHash: string) {
    const e = this.seen.get(txHash);
    if (!e) return null;
    const confirmed = this.height - e.receipt.blockHeight >= this.finalityBlocks;
    return confirmed ? { payload: e.payload, receipt: { ...e.receipt, confirmed } } : null;
  }
  get blockHeight(): number {
    return this.height;
  }
}

export interface CommitOutcome {
  ok: boolean;
  code: string | null;
  receipt: Receipt | null;
  readback: { payloadHash: string | null; equal: boolean } | null;
}

export function commitPreregistration(o: {
  chain: ChainAdapter;
  doc: unknown;
  signer: string;
  nonce: number;
  experimentId?: string;
  /** For tests: submit this payload instead of the hash-only one. */
  payloadOverride?: unknown;
}): CommitOutcome {
  const hash = canonicalDocHash(o.doc);
  const payload: unknown =
    o.payloadOverride ??
    ({
      kind: "nearesis.prereg.v1",
      hash,
      ...(o.experimentId ? { experimentId: o.experimentId } : {}),
    } satisfies CommitPayload);
  const r = o.chain.submit({ signer: o.signer, nonce: o.nonce, payload });
  if (!r.ok) return { ok: false, code: r.code, receipt: null, readback: null };
  return { ok: true, code: null, receipt: r.receipt, readback: null };
}

/** Read back after finality and compare to the canonical hash. Unconfirmed receipts read back as null (not committed). */
export function readbackCommitment(
  chain: ChainAdapter,
  receipt: Receipt,
  doc: unknown,
): { payloadHash: string | null; equal: boolean; receipt: Receipt | null } {
  const r = chain.read(receipt.txHash);
  const h =
    r && typeof r.payload === "object" && r.payload !== null
      ? ((r.payload as { hash?: unknown }).hash ?? null)
      : null;
  const payloadHash = typeof h === "string" ? h : null;
  return { payloadHash, equal: payloadHash === canonicalDocHash(doc), receipt: r?.receipt ?? null };
}

/**
 * Lockbox opening gate. The lockbox opens only after a confirmed commit whose readback equals the canonical hash, and
 * whose block was produced before the opening. Otherwise the run is labelled `post-hoc registration`.
 */
export type LockboxDecision =
  | { open: true; label: "preregistered"; commitBlock: number; openedAtBlock: number }
  | {
      open: false;
      label: "post-hoc registration";
      reason: "NO_CONFIRMED_COMMIT" | "READBACK_MISMATCH" | "COMMIT_AFTER_OPEN";
    };

export function lockboxGate(o: {
  chain: ChainAdapter;
  doc: unknown;
  receipt: Receipt | null;
  openingBlock: number;
}): LockboxDecision {
  if (!o.receipt) return { open: false, label: "post-hoc registration", reason: "NO_CONFIRMED_COMMIT" };
  const rb = readbackCommitment(o.chain, o.receipt, o.doc);
  if (!rb.receipt) return { open: false, label: "post-hoc registration", reason: "NO_CONFIRMED_COMMIT" };
  if (!rb.equal) return { open: false, label: "post-hoc registration", reason: "READBACK_MISMATCH" };
  if (rb.receipt.blockHeight >= o.openingBlock)
    return { open: false, label: "post-hoc registration", reason: "COMMIT_AFTER_OPEN" };
  return {
    open: true,
    label: "preregistered",
    commitBlock: rb.receipt.blockHeight,
    openedAtBlock: o.openingBlock,
  };
}
