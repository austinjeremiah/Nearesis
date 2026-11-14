import { existsSync, readFileSync } from "node:fs";
import { readbackLive } from "./live.ts";

export interface LiveCommitEvidence {
  txHash: string;
  payloadHash: string;
  contract: string;
  finality: string;
  succeeded: boolean;
  method: string;
  deposit: string;
  viewTimestampNs: string | null;
  equal: boolean;
}

/**
 * Re-verifies the recorded testnet preregistration commitment against the chain NOW (tx status and contract view at FINAL).
 * Returns null unless --live was requested and a recorded commit exists. No write is made here.
 */
export async function liveCommitEvidence(recordFile: string): Promise<LiveCommitEvidence | null> {
  if (process.env.NEARESIS_ACCEPT_LIVE !== "1" || !existsSync(recordFile)) return null;
  const rec = JSON.parse(readFileSync(recordFile, "utf8")) as {
    payloadHash: string;
    txHash: string;
    contract: string;
  };
  const rb = await readbackLive(rec.txHash, rec.payloadHash);
  return {
    txHash: rec.txHash,
    payloadHash: rec.payloadHash,
    contract: rb.receiver,
    finality: rb.finality,
    succeeded: rb.succeeded,
    method: rb.method,
    deposit: rb.deposit,
    viewTimestampNs: rb.viewTimestampNs,
    equal: rb.equal,
  };
}
