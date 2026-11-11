/**
 * Release command: pre-flight, approval enforcement, idempotent submit with query-before-retry, receipt.
 * Pure logic over a `ChainWrite`; production use needs a real adapter and signer, which are HUMAN ONLY.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ApprovalStore, actionHash } from "./approval.ts";
import type { ApprovalScope, Denial } from "./approval.ts";
import { RpcTimeout } from "./chain.ts";
import type { ChainWrite, Network, TxIntent, TxRecord } from "./chain.ts";

export const DISABLED_METHODS = [
  "transfer",
  "send_money",
  "swap",
  "ft_transfer",
  "ft_transfer_call",
  "withdraw",
  "deploy_contract",
  "add_key",
  "delete_key",
  "stake",
] as const;
export const MAX_BROADCASTS = 2;

export interface ReleasePolicy {
  expectedChainId: Record<Network, string>;
  allowlist: { contracts: string[]; methods: string[] };
  balanceCeiling: bigint;
  feeCeiling: bigint;
  signer: string;
  /** Networks on which an approval record is mandatory. Mainnet always. */
  approvalRequiredOn: Network[];
  /** Blocks added to the current height for a (re)broadcast intent's expiry. */
  intentWindow: number;
}
export interface ReleaseRequest {
  network: Network;
  contract: string;
  method: string;
  payloadHash: string;
  maxCost: string;
  approvalId?: string;
  mode: "dry-run" | "execute";
}
export interface Receipt {
  network: Network;
  chainId: string;
  hash: string;
  payloadHash: string;
  signer: string;
  target: string;
  height: number;
  finalHeight: number;
  finality: "FINAL";
  fee: string;
  approvalRef: string | null;
}
export type ReleaseStatus =
  | "DENIED"
  | "PREFLIGHT_FAILED"
  | "DRY_RUN_OK"
  | "FINAL"
  | "PENDING_FINALITY"
  | "HELD_UNCERTAIN"
  | "HUMAN_REVIEW";
export interface ReleaseResult {
  status: ReleaseStatus;
  reasonCode: string | null;
  receipt?: Receipt;
  preflight?: PreflightRecord;
  broadcasts: number;
}
export interface PreflightRecord {
  chainId: string;
  network: Network;
  balance: string;
  method: string;
  contract: string;
  feeEstimate: string;
  payloadHash: string;
}
export type PreflightResult = { ok: true; record: PreflightRecord } | { ok: false; reason: string };

export interface LedgerEntry {
  actionHash: string;
  state: "BROADCASTING" | "INCLUDED" | "FINAL" | "HUMAN_REVIEW";
  broadcasts: number;
  hash: string | null;
  approvalId: string | null;
  receipt: Receipt | null;
  review: { reason: string; evidence: unknown } | null;
  lastExpiryHeight: number | null;
}
/** File-backed ledger so a killed process can resume without re-broadcasting. */
export class Ledger {
  constructor(private readonly path: string) {}
  private load(): Record<string, LedgerEntry> {
    return existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, LedgerEntry>)
      : {};
  }
  get(key: string): LedgerEntry | undefined {
    return this.load()[key];
  }
  put(e: LedgerEntry): void {
    const all = this.load();
    all[e.actionHash] = e;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(all, null, 2));
    renameSync(this.path + ".tmp", this.path);
  }
}

export interface ReleaseDeps {
  chain: ChainWrite;
  approvals: ApprovalStore;
  ledger: Ledger;
  policy: ReleasePolicy;
  /** Polls for finality; the fixture advances its chain here. */
  tick?: () => void;
  finalityPolls?: number;
  /** Test hook: throws to simulate a process kill after the broadcast and before it is recorded. */
  afterBroadcast?: () => void;
  audit?: Array<{ kind: string; detail: string }>;
}

const HEX64 = /^[0-9a-f]{64}$/;

export async function preflight(
  chain: ChainWrite,
  req: Pick<ReleaseRequest, "network" | "contract" | "method" | "payloadHash" | "maxCost">,
  policy: ReleasePolicy,
): Promise<PreflightResult> {
  if ((DISABLED_METHODS as readonly string[]).includes(req.method))
    return { ok: false, reason: "ACTION_DISABLED" };
  if (!policy.allowlist.methods.includes(req.method) || !policy.allowlist.contracts.includes(req.contract))
    return { ok: false, reason: "NOT_ALLOWLISTED" };
  if (!HEX64.test(req.payloadHash)) return { ok: false, reason: "PAYLOAD_NOT_HASH" };
  if (chain.network !== req.network) return { ok: false, reason: "NETWORK_MISMATCH" };
  try {
    const chainId = await chain.chainId(); // read from the RPC, never from configuration
    if (chainId !== policy.expectedChainId[req.network]) return { ok: false, reason: "CHAIN_ID_MISMATCH" };
    const balance = await chain.balance(policy.signer);
    if (balance > policy.balanceCeiling) return { ok: false, reason: "BALANCE_ABOVE_CEILING" };
    const fee = await chain.estimateFee(intentFor(req, policy, 0, 0, ""));
    if (fee > policy.feeCeiling || fee > BigInt(req.maxCost))
      return { ok: false, reason: "FEE_ABOVE_CEILING" };
    return {
      ok: true,
      record: {
        chainId,
        network: chain.network,
        balance: balance.toString(),
        method: req.method,
        contract: req.contract,
        feeEstimate: fee.toString(),
        payloadHash: req.payloadHash,
      },
    };
  } catch (e) {
    if (e instanceof RpcTimeout) return { ok: false, reason: "RPC_TIMEOUT" };
    return { ok: false, reason: "RPC_ERROR" };
  }
}

function intentFor(
  req: Pick<ReleaseRequest, "network" | "contract" | "method" | "payloadHash">,
  policy: ReleasePolicy,
  height: number,
  _n: number,
  key: string,
): TxIntent {
  return {
    network: req.network,
    chainId: policy.expectedChainId[req.network],
    signer: policy.signer,
    receiver: req.contract,
    method: req.method,
    payloadHash: req.payloadHash,
    deposit: "0",
    nonceKey: key,
    expiryHeight: height + policy.intentWindow,
  };
}

export async function runRelease(deps: ReleaseDeps, req: ReleaseRequest): Promise<ReleaseResult> {
  const { chain, approvals, ledger, policy } = deps;
  const scope: ApprovalScope = {
    network: req.network,
    contract: req.contract,
    method: req.method,
    payloadHash: req.payloadHash,
    maxCost: req.maxCost,
  };
  const ah = actionHash(scope);
  const deny = (d: Denial | string, broadcasts = 0): ReleaseResult => ({
    status: "DENIED",
    reasonCode: d,
    broadcasts,
  });
  const needsApproval = req.network === "mainnet" || policy.approvalRequiredOn.includes(req.network);
  const existing = ledger.get(ah);

  // Denial happens before any chain call, including reads.
  if (!existing || req.mode === "dry-run") {
    if (needsApproval) {
      const d = approvals.check(req.approvalId, scope);
      if (d) return deny(d);
    }
  }
  if (existing && req.mode === "execute") return resume(deps, existing, req);
  if ((DISABLED_METHODS as readonly string[]).includes(req.method)) {
    deps.audit?.push({ kind: "disabled-action", detail: req.method });
  }
  const pf = await preflight(chain, req, policy);
  if (!pf.ok) return { status: "PREFLIGHT_FAILED", reasonCode: pf.reason, broadcasts: 0 };
  if (req.mode === "dry-run")
    return { status: "DRY_RUN_OK", reasonCode: null, preflight: pf.record, broadcasts: 0 };

  let approvalId: string | null = null;
  if (needsApproval) {
    const c = approvals.consume(req.approvalId, scope);
    if (typeof c === "string") return deny(c);
    approvalId = c.id;
  }
  const entry: LedgerEntry = {
    actionHash: ah,
    state: "BROADCASTING",
    broadcasts: 0,
    hash: null,
    approvalId,
    receipt: null,
    review: null,
    lastExpiryHeight: null,
  };
  ledger.put(entry);
  return submit(deps, entry, req);
}

async function submit(deps: ReleaseDeps, entry: LedgerEntry, req: ReleaseRequest): Promise<ReleaseResult> {
  const { chain, ledger, policy } = deps;
  const height = await chain.currentHeight();
  const intent = intentFor(req, policy, height, entry.broadcasts, entry.actionHash);
  entry.broadcasts++;
  entry.lastExpiryHeight = intent.expiryHeight;
  ledger.put(entry); // recorded BEFORE the call, so a kill cannot hide a broadcast
  try {
    const { hash } = await chain.broadcast(intent);
    deps.afterBroadcast?.();
    entry.hash = hash;
    entry.state = "INCLUDED";
    ledger.put(entry);
    return confirm(deps, entry, req);
  } catch (e) {
    if (!(e instanceof RpcTimeout)) throw e;
    return resolveUncertain(deps, entry, req);
  }
}

/** Outcome unknown: query the chain by key. Never rebroadcast something that may have succeeded. */
async function resolveUncertain(
  deps: ReleaseDeps,
  entry: LedgerEntry,
  req: ReleaseRequest,
): Promise<ReleaseResult> {
  const { chain, ledger } = deps;
  let found: TxRecord | null;
  let height: number;
  try {
    found = await chain.findByKey(entry.actionHash);
    height = await chain.currentHeight();
  } catch (e) {
    return hold(deps, entry, "AMBIGUOUS_STATUS", { error: e instanceof Error ? e.message : String(e) });
  }
  if (found) {
    entry.hash = found.hash;
    entry.state = "INCLUDED";
    ledger.put(entry);
    return confirm(deps, entry, req);
  }
  const windowPassed = entry.lastExpiryHeight !== null && height > entry.lastExpiryHeight;
  if (!windowPassed)
    return { status: "HELD_UNCERTAIN", reasonCode: "ABSENT_WINDOW_OPEN", broadcasts: entry.broadcasts };
  if (entry.broadcasts >= MAX_BROADCASTS)
    return hold(deps, entry, "BROADCAST_BUDGET_EXHAUSTED", { broadcasts: entry.broadcasts });
  // Absent and the previous intent can no longer be included: a rebroadcast cannot duplicate it.
  return submit(deps, entry, req);
}

function hold(deps: ReleaseDeps, entry: LedgerEntry, reason: string, evidence: unknown): ReleaseResult {
  entry.state = "HUMAN_REVIEW";
  entry.review = { reason, evidence };
  deps.ledger.put(entry);
  return { status: "HUMAN_REVIEW", reasonCode: reason, broadcasts: entry.broadcasts };
}

async function confirm(deps: ReleaseDeps, entry: LedgerEntry, _req: ReleaseRequest): Promise<ReleaseResult> {
  const { chain, ledger } = deps;
  const polls = deps.finalityPolls ?? 3;
  for (let i = 0; i < polls; i++) {
    let tx: TxRecord | null;
    try {
      tx = await chain.getTx(entry.hash!);
    } catch (e) {
      return hold(deps, entry, "AMBIGUOUS_STATUS", { error: e instanceof Error ? e.message : String(e) });
    }
    if (tx?.finalHeight != null) {
      const receipt: Receipt = {
        network: tx.intent.network,
        chainId: tx.intent.chainId,
        hash: tx.hash,
        payloadHash: tx.intent.payloadHash,
        signer: tx.intent.signer,
        target: tx.intent.receiver,
        height: tx.height,
        finalHeight: tx.finalHeight,
        finality: "FINAL",
        fee: tx.fee.toString(),
        approvalRef: entry.approvalId,
      };
      entry.state = "FINAL";
      entry.receipt = receipt;
      ledger.put(entry);
      return { status: "FINAL", reasonCode: null, receipt, broadcasts: entry.broadcasts };
    }
    deps.tick?.();
  }
  return { status: "PENDING_FINALITY", reasonCode: null, broadcasts: entry.broadcasts };
}

/** A repeated command resumes from the ledger: it queries, confirms or holds, and never blindly rebroadcasts. */
async function resume(deps: ReleaseDeps, entry: LedgerEntry, req: ReleaseRequest): Promise<ReleaseResult> {
  if (entry.state === "FINAL")
    return { status: "FINAL", reasonCode: null, receipt: entry.receipt!, broadcasts: entry.broadcasts };
  if (entry.state === "HUMAN_REVIEW")
    return { status: "HUMAN_REVIEW", reasonCode: entry.review?.reason ?? null, broadcasts: entry.broadcasts };
  if (entry.hash) return confirm(deps, entry, req);
  return resolveUncertain(deps, entry, req);
}
