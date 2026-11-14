/** Pure per-block aggregation of a FastNEAR neardata block (`/v0/block/:height`, final finality). No I/O. */

export const RT_PROVIDER = "near-rpc-public";
export const RT_FEED_ID = "near-mainnet-final";

export interface BlockAggregate {
  height: number;
  blockHash: string;
  prevHash: string;
  prevHeight: number;
  blockTsMs: number;
  state: "final" | "provisional";
  txCount: number;
  receiptCount: number | null;
  gasBurnt: bigint;
  tokensBurntYocto: bigint;
  signers: string[];
  chunksIncluded: number;
  receiverIds: string[];
  receiverTx: number[];
  receiverRcpt: Array<number | null>;
}

interface Outcome {
  gas_burnt?: number | string;
  tokens_burnt?: string;
  executor_id?: string;
}
interface Wire {
  block?: {
    header?: {
      height?: number;
      hash?: string;
      prev_hash?: string;
      prev_height?: number;
      timestamp_nanosec?: string;
      chunks_included?: number;
    };
  };
  shards?: Array<{
    chunk?: {
      transactions?: Array<{
        transaction?: { hash?: string; signer_id?: string; receiver_id?: string };
        outcome?: { execution_outcome?: { outcome?: Outcome } };
      }>;
    } | null;
    receipt_execution_outcomes?: Array<{
      execution_outcome?: { id?: string; outcome?: Outcome };
      receipt?: { receiver_id?: string; receipt_id?: string } | null;
    }>;
  }>;
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`neardata: ${what} is not a non-negative integer: ${String(v)}`);
};

/**
 * Gas and tokens burnt include BOTH the transaction-to-receipt conversion outcome (carried on the chunk transaction) and every
 * receipt execution outcome of the block, matching NEAR's per-block gas accounting. A transaction hash or receipt id seen twice
 * in one block is counted once (dedupe key), so replaying the same block yields identical numbers.
 */
export function aggregateBlock(wire: unknown, state: "final" | "provisional" = "final"): BlockAggregate {
  const w = wire as Wire;
  const h = w?.block?.header;
  if (
    !h ||
    typeof h.height !== "number" ||
    !h.hash ||
    !h.prev_hash ||
    typeof h.timestamp_nanosec !== "string"
  )
    throw new Error("neardata: block header missing required fields");
  const seenTx = new Set<string>();
  const seenRcpt = new Set<string>();
  const signers = new Set<string>();
  const perRecv = new Map<string, { tx: number; rc: number }>();
  const bump = (id: string, k: "tx" | "rc"): void => {
    const e = perRecv.get(id) ?? { tx: 0, rc: 0 };
    e[k]++;
    perRecv.set(id, e);
  };
  let gas = 0n;
  let tokens = 0n;
  let tx = 0;
  let rc = 0;
  for (const s of w.shards ?? []) {
    for (const t of s.chunk?.transactions ?? []) {
      const hash = t.transaction?.hash;
      if (!hash) throw new Error("neardata: transaction without hash");
      if (seenTx.has(hash)) continue;
      seenTx.add(hash);
      tx++;
      if (t.transaction?.signer_id) signers.add(t.transaction.signer_id);
      if (t.transaction?.receiver_id) bump(t.transaction.receiver_id, "tx");
      const o = t.outcome?.execution_outcome?.outcome;
      if (o) {
        gas += big(o.gas_burnt ?? 0, "gas_burnt");
        tokens += big(o.tokens_burnt ?? "0", "tokens_burnt");
      }
    }
    for (const r of s.receipt_execution_outcomes ?? []) {
      const id = r.execution_outcome?.id ?? r.receipt?.receipt_id;
      if (!id) throw new Error("neardata: receipt outcome without id");
      if (seenRcpt.has(id)) continue;
      seenRcpt.add(id);
      rc++;
      const o = r.execution_outcome?.outcome;
      if (o) {
        gas += big(o.gas_burnt ?? 0, "gas_burnt");
        tokens += big(o.tokens_burnt ?? "0", "tokens_burnt");
      }
      const recv = r.receipt?.receiver_id ?? o?.executor_id;
      if (recv) bump(recv, "rc");
    }
  }
  const ids = [...perRecv.keys()].sort();
  return {
    height: h.height,
    blockHash: h.hash,
    prevHash: h.prev_hash,
    prevHeight: typeof h.prev_height === "number" ? h.prev_height : h.height - 1,
    blockTsMs: Number(BigInt(h.timestamp_nanosec) / 1_000_000n),
    state,
    txCount: tx,
    receiptCount: rc,
    gasBurnt: gas,
    tokensBurntYocto: tokens,
    signers: [...signers].sort(),
    chunksIncluded: h.chunks_included ?? 0,
    receiverIds: ids,
    receiverTx: ids.map((i) => perRecv.get(i)!.tx),
    receiverRcpt: ids.map((i) => perRecv.get(i)!.rc),
  };
}

export type WriteDecision = "insert" | "noop" | "promote" | "replace_provisional" | "anomaly_final_conflict";

/**
 * Finality state machine for one height. A final row is never overwritten by a provisional one and never by a final row with a
 * different hash (that would be a reorg of a final block: reported as an anomaly and refused). A provisional row is promoted by a
 * final row with the same hash, or replaced by any row with a different hash (the provisional fork lost).
 */
export function decideWrite(
  existing: { blockHash: string; state: "final" | "provisional" } | null,
  incoming: { blockHash: string; state: "final" | "provisional" },
): WriteDecision {
  if (!existing) return "insert";
  if (existing.state === "final") {
    if (existing.blockHash !== incoming.blockHash) return "anomaly_final_conflict";
    return "noop";
  }
  if (existing.blockHash === incoming.blockHash) return incoming.state === "final" ? "promote" : "noop";
  return "replace_provisional";
}
