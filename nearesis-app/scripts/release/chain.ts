/**
 * Chain adapter for the release tooling: read paths and a fixture chain. There is deliberately NO real write
 * implementation here: a real signer and broadcast are human-only (ch.17, owner correction 5). `ChainWrite` is
 * implemented only by `FixtureChain`, which never signs anything (hashes are derived from the intent).
 */
import { createHash } from "node:crypto";

export type Network = "sandbox" | "testnet" | "mainnet";
export const CHAIN_IDS: Record<Network, string> = {
  sandbox: "sandbox",
  testnet: "testnet",
  mainnet: "mainnet",
};

export interface TxIntent {
  network: Network;
  chainId: string;
  signer: string;
  receiver: string;
  method: string;
  payloadHash: string;
  deposit: string;
  /** Idempotency key carried in the intent (action hash). */
  nonceKey: string;
  /** Last block height at which this intent may still be included. */
  expiryHeight: number;
}
export interface TxRecord {
  hash: string;
  intent: TxIntent;
  height: number;
  finalHeight: number | null;
  fee: bigint;
}
export interface ChainRead {
  readonly network: Network;
  chainId(): Promise<string>;
  currentHeight(): Promise<number>;
  balance(account: string): Promise<bigint>;
  estimateFee(intent: TxIntent): Promise<bigint>;
  getTx(hash: string): Promise<TxRecord | null>;
  findByKey(nonceKey: string): Promise<TxRecord | null>;
  listSignerTxs(signer: string, fromHeight: number): Promise<TxRecord[]>;
}
export interface ChainWrite extends ChainRead {
  broadcast(intent: TxIntent): Promise<{ hash: string }>;
}

export class RpcTimeout extends Error {
  constructor(what: string) {
    super(`rpc timeout: ${what}`);
  }
}

export type BroadcastFault =
  | "ok"
  | "timeout-included" // the call times out but the transaction was included
  | "timeout-absent" // the call times out and the transaction was not included
  | "ambiguous"; // accepted by the node, later status reads conflict

export interface FixtureOptions {
  network: Network;
  chainId?: string;
  balance?: bigint;
  fee?: bigint;
  finalityDepth?: number;
  /** If true the chain refuses a second inclusion of the same nonceKey (idempotent payload rule). */
  dedupeByNonceKey?: boolean;
}

/** Deterministic in-memory chain. Counts every call so tests can prove 0 chain calls on denial paths. */
export class FixtureChain implements ChainWrite {
  readonly network: Network;
  height = 100;
  txs: TxRecord[] = [];
  calls = { read: 0, broadcast: 0 };
  broadcastLog: TxIntent[] = [];
  nextFault: BroadcastFault = "ok";
  rpcDown = false;
  ambiguous = new Set<string>();
  private readonly chain: string;
  private bal: bigint;
  private feeAmt: bigint;
  private depth: number;
  private dedupe: boolean;
  constructor(o: FixtureOptions) {
    this.network = o.network;
    this.chain = o.chainId ?? CHAIN_IDS[o.network];
    this.bal = o.balance ?? 1_000n;
    this.feeAmt = o.fee ?? 1n;
    this.depth = o.finalityDepth ?? 2;
    this.dedupe = o.dedupeByNonceKey ?? false;
  }
  private read() {
    this.calls.read++;
    if (this.rpcDown) throw new RpcTimeout("read");
  }
  advance(n = 1): void {
    this.height += n;
    for (const t of this.txs)
      if (t.finalHeight === null && this.height >= t.height + this.depth)
        t.finalHeight = t.height + this.depth;
  }
  async chainId() {
    this.read();
    return this.chain;
  }
  async currentHeight() {
    this.read();
    return this.height;
  }
  async balance() {
    this.read();
    return this.bal;
  }
  async estimateFee() {
    this.read();
    return this.feeAmt;
  }
  async getTx(hash: string) {
    this.read();
    if (this.ambiguous.has(hash)) throw new Error("conflicting status for " + hash);
    return this.txs.find((t) => t.hash === hash) ?? null;
  }
  async findByKey(nonceKey: string) {
    this.read();
    const hit = this.txs.find((t) => t.intent.nonceKey === nonceKey) ?? null;
    if (hit && this.ambiguous.has(hit.hash)) throw new Error("conflicting status for " + hit.hash);
    return hit;
  }
  async listSignerTxs(signer: string, fromHeight: number) {
    this.read();
    return this.txs.filter((t) => t.intent.signer === signer && t.height >= fromHeight);
  }
  private include(intent: TxIntent): TxRecord {
    if (this.dedupe) {
      const existing = this.txs.find((t) => t.intent.nonceKey === intent.nonceKey);
      if (existing) return existing;
    }
    this.height += 1;
    const hash = createHash("sha256")
      .update(`${intent.nonceKey}:${this.txs.length}:${this.height}`)
      .digest("hex")
      .slice(0, 44);
    const rec: TxRecord = { hash, intent, height: this.height, finalHeight: null, fee: this.feeAmt };
    this.txs.push(rec);
    this.bal -= this.feeAmt;
    return rec;
  }
  async broadcast(intent: TxIntent): Promise<{ hash: string }> {
    this.calls.broadcast++;
    this.broadcastLog.push(intent);
    const fault = this.nextFault;
    this.nextFault = "ok";
    if (fault === "timeout-absent") throw new RpcTimeout("broadcast");
    const rec = this.include(intent);
    if (fault === "timeout-included") throw new RpcTimeout("broadcast");
    if (fault === "ambiguous") this.ambiguous.add(rec.hash);
    return { hash: rec.hash };
  }
  isFinal(hash: string): boolean {
    return this.txs.find((t) => t.hash === hash)?.finalHeight != null;
  }
}

/** Allowlisted, read-only NEAR JSON-RPC client (real network reads only; never used by the offline tests). */
export const NEAR_READ_METHODS = [
  "status",
  "block",
  "tx",
  "EXPERIMENTAL_tx_status",
  "gas_price",
  "query",
] as const;
export class NearReadOnlyRpc {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 8000,
  ) {}
  async call(method: string, params: unknown): Promise<unknown> {
    if (!(NEAR_READ_METHODS as readonly string[]).includes(method))
      throw new Error(`method not allowed: ${method}`);
    if (
      method === "query" &&
      (params as { request_type?: string })?.request_type?.startsWith("call_function")
    )
      throw new Error("function calls are not read-only; denied");
    const r = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "release", method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const j = (await r.json()) as { result?: unknown; error?: unknown };
    if (j.error) throw new Error("rpc error");
    return j.result;
  }
  async chainId(): Promise<string> {
    return ((await this.call("status", [])) as { chain_id: string }).chain_id;
  }
}
