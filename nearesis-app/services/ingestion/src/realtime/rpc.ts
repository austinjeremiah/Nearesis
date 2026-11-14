import type { Clock } from "../clock.ts";
import { withRetry } from "../rate/retry.ts";
import type { BlockAggregate } from "./aggregate.ts";
import type { BlockSource, SlotSource } from "./neardata.ts";

/**
 * dRPC public NEAR endpoint: no key, no signup. Measured 9 req/s sustained for 45 s with zero 429 (FastNEAR free RPC and the
 * NEAR foundation RPC throttle at ~2-3 req/s, neardata at ~0.5 req/s; see docs/sources/NEAR-REALTIME-OPTIONS.md).
 * Override with NEARESIS_RT_RPC_URL (e.g. a keyed endpoint the owner approves).
 */
export const DEFAULT_RPC_URL = "https://near.drpc.org";
export const RPC_INTERVAL_MS = 50;
export const rpcRateKey = (url: string): string => `ingestion:rate:near-rpc:${new URL(url).host}`;

/** Merkle root of an empty transaction list (32 x base58 "1"). */
const EMPTY_TX_ROOT = "11111111111111111111111111111111";

interface RpcHeader {
  height: number;
  hash: string;
  prev_hash: string;
  prev_height?: number;
  timestamp_nanosec: string;
  chunks_included?: number;
}
interface RpcBlock {
  header: RpcHeader;
  chunks: Array<{
    chunk_hash: string;
    height_included: number;
    shard_id: number;
    gas_used: number | string;
    balance_burnt: string;
    tx_root?: string;
  }>;
}
interface RpcChunk {
  transactions: Array<{ hash: string; signer_id: string; receiver_id: string }>;
  receipts: Array<{ receipt_id: string; receiver_id: string }>;
}

const uint = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`rpc: ${what} is not a non-negative integer: ${String(v)}`);
};

/**
 * Builds the block aggregate from the RPC `block` and the `chunk` of every shard that included a NEW chunk at this height
 * (height_included == height; a repeated header of an earlier chunk is skipped so its transactions are never counted twice).
 * tx_count, signers and per-receiver tx counts are exact for the block. receipt_count/receiver receipts are the receipts
 * carried in the block's new chunks (incoming receipts), not executed outcomes. gas_burnt / tokens_burnt are the chunk-header
 * `gas_used` / `balance_burnt` reported in THIS block, which nearcore defines as the result of applying the PREVIOUS block
 * (verified equal to the neardata outcome sums of block h-1 on 3 consecutive mainnet blocks): a one-block shift, exact in total.
 */
export function aggregateRpcBlock(
  block: RpcBlock,
  chunks: Map<string, RpcChunk>,
  withReceipts = false,
): BlockAggregate {
  const h = block.header;
  const seenTx = new Set<string>();
  const seenRcpt = new Set<string>();
  const signers = new Set<string>();
  const per = new Map<string, { tx: number; rc: number }>();
  const bump = (id: string, k: "tx" | "rc"): void => {
    const e = per.get(id) ?? { tx: 0, rc: 0 };
    e[k]++;
    per.set(id, e);
  };
  let gas = 0n;
  let tok = 0n;
  let tx = 0;
  let rc = 0;
  for (const c of block.chunks) {
    if (c.height_included !== h.height) continue;
    gas += uint(c.gas_used, "gas_used");
    tok += uint(c.balance_burnt, "balance_burnt");
    const body = chunks.get(c.chunk_hash);
    if (!body) {
      // tx-only mode skips the body of a chunk whose tx_root is the empty root: it has no transactions by construction
      if (!withReceipts && c.tx_root === EMPTY_TX_ROOT) continue;
      throw new Error(`rpc: chunk ${c.chunk_hash} body missing`);
    }
    for (const t of body.transactions) {
      if (seenTx.has(t.hash)) continue;
      seenTx.add(t.hash);
      tx++;
      signers.add(t.signer_id);
      bump(t.receiver_id, "tx");
    }
    for (const r of withReceipts ? body.receipts : []) {
      if (seenRcpt.has(r.receipt_id)) continue;
      seenRcpt.add(r.receipt_id);
      rc++;
      bump(r.receiver_id, "rc");
    }
  }
  const ids = [...per.keys()].sort();
  return {
    height: h.height,
    blockHash: h.hash,
    prevHash: h.prev_hash,
    prevHeight: typeof h.prev_height === "number" ? h.prev_height : h.height - 1,
    blockTsMs: Number(BigInt(h.timestamp_nanosec) / 1_000_000n),
    state: "final",
    txCount: tx,
    receiptCount: withReceipts ? rc : null,
    gasBurnt: gas,
    tokensBurntYocto: tok,
    signers: [...signers].sort(),
    chunksIncluded: block.chunks.filter((c) => c.height_included === h.height).length,
    receiverIds: ids,
    receiverTx: ids.map((i) => per.get(i)!.tx),
    receiverRcpt: ids.map((i) => (withReceipts ? per.get(i)!.rc : null)),
  };
}

export class RpcError extends Error {
  constructor(
    readonly rpcName: string,
    readonly cause2: string,
    msg: string,
  ) {
    super(msg);
  }
}

/** Final blocks only: a height above the current `finality: final` head is never requested (it could still reorg). */
export class RpcBlockSource implements BlockSource {
  requests = 0;
  rateLimited = 0;
  private headBlock: RpcBlock | null = null;
  constructor(
    private readonly slots: SlotSource,
    private readonly clock: Clock,
    private readonly url: string = DEFAULT_RPC_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = 20_000,
    /** Fetch every chunk body to also count receipts (about 11 calls per block instead of about 4; exceeds the free limits at 1.75 blocks/s). */
    private readonly withReceipts: boolean = false,
  ) {}

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    return withRetry(
      async () => {
        await this.slots.acquire(); // shared coordinator for this provider
        this.requests++;
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status === 503) {
          this.rateLimited++;
          const ra = Number(res.headers.get("retry-after"));
          await this.slots.penalizeUntil(
            this.clock.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5_000),
          );
          throw new Error(`fetch failed: rpc ${method} HTTP ${res.status}`); // transient: retried with backoff
        }
        if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
        const j = (await res.json()) as {
          result?: T;
          error?: { name?: string; cause?: { name?: string }; data?: unknown; message?: string };
        };
        if (j.error)
          throw new RpcError(
            j.error.name ?? "",
            j.error.cause?.name ?? "",
            `rpc ${method}: ${j.error.cause?.name ?? j.error.message}`,
          );
        return j.result as T;
      },
      { attempts: 6, baseMs: 500, maxMs: 8000 },
    );
  }

  async lastFinalHeight(): Promise<number> {
    this.headBlock = await this.rpc<RpcBlock>("block", { finality: "final" });
    return this.headBlock.header.height;
  }

  async getBlock(height: number): Promise<BlockAggregate | null> {
    let block: RpcBlock;
    if (this.headBlock && this.headBlock.header.height === height) block = this.headBlock;
    else {
      if (!this.headBlock || height > this.headBlock.header.height) await this.lastFinalHeight();
      if (height > (this.headBlock as RpcBlock).header.height) return null; // not final yet
      try {
        block = await this.rpc<RpcBlock>("block", { block_id: height });
      } catch (e) {
        if (e instanceof RpcError && e.cause2 === "UNKNOWN_BLOCK") return null; // skipped height
        throw e;
      }
    }
    const fresh = block.chunks.filter(
      (c) => c.height_included === height && (this.withReceipts || c.tx_root !== EMPTY_TX_ROOT),
    );
    const bodies = await Promise.all(
      fresh.map(
        async (c) => [c.chunk_hash, await this.rpc<RpcChunk>("chunk", { chunk_id: c.chunk_hash })] as const,
      ),
    );
    return aggregateRpcBlock(block, new Map(bodies), this.withReceipts);
  }
}
