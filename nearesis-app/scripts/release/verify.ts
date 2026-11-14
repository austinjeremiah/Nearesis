/** Post-write verification (N11): independent readback, field comparison, signer-activity audit, disabled actions. */
import type { ChainRead } from "./chain.ts";
import type { Receipt } from "./release.ts";
import { DISABLED_METHODS } from "./release.ts";

export interface ExpectedWrite {
  network: string;
  chainId: string;
  payloadHash: string;
  signer: string;
  target: string;
  maxFee: bigint;
  fromHeight: number;
}
export interface Verification {
  ok: boolean;
  mismatches: string[];
  signerTxCount: number;
}

/** Does not trust the application's own log: re-reads the tx and the signer's full activity from the chain. */
export async function verifyReceipt(chain: ChainRead, r: Receipt, e: ExpectedWrite): Promise<Verification> {
  const mismatches: string[] = [];
  const tx = await chain.getTx(r.hash);
  if (!tx) mismatches.push("hash: not found on chain");
  else {
    const chk = (name: string, a: unknown, b: unknown) =>
      a !== b && mismatches.push(`${name}: receipt ${String(a)} != chain ${String(b)}`);
    chk("payloadHash", r.payloadHash, tx.intent.payloadHash);
    chk("signer", r.signer, tx.intent.signer);
    chk("target", r.target, tx.intent.receiver);
    chk("height", r.height, tx.height);
    chk("fee", r.fee, tx.fee.toString());
    if (tx.finalHeight === null) mismatches.push("finality: not final");
  }
  if (r.network !== e.network) mismatches.push(`network: ${r.network} != ${e.network}`);
  if (r.chainId !== e.chainId) mismatches.push(`chainId: ${r.chainId} != ${e.chainId}`);
  if (r.payloadHash !== e.payloadHash) mismatches.push("payloadHash: differs from the manifest");
  if (r.signer !== e.signer) mismatches.push("signer: differs from the expected signer");
  if (r.target !== e.target) mismatches.push("target: differs from the manifest target");
  if (BigInt(r.fee) > e.maxFee) mismatches.push("fee: above the ceiling");
  const txs = await chain.listSignerTxs(e.signer, e.fromHeight);
  if (txs.length !== 1)
    mismatches.push(`signer activity: ${txs.length} transactions in the window, expected exactly 1`);
  return { ok: mismatches.length === 0, mismatches, signerTxCount: txs.length };
}

/** Release tooling entry for any other action: refused and audited. */
export function guardAction(method: string, audit: Array<{ kind: string; detail: string }>): void {
  if ((DISABLED_METHODS as readonly string[]).includes(method)) {
    audit.push({ kind: "disabled-action-refused", detail: method });
    throw new Error(`action disabled in release tooling: ${method}`);
  }
}
