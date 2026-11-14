import { NearReadOnlyRpc } from "./chain.ts";
import type { ChainWrite, Network, TxIntent, TxRecord } from "./chain.ts";

const notRead = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available on the read-only live pre-flight chain`);
};

export const NEAR_RPC: Record<"testnet" | "mainnet", string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

/**
 * Real NEAR reads for the pre-flight (chain id, balance, fee estimate, commitment view). It cannot broadcast, sign or look up
 * transactions: those members throw. The single contract view it may issue is `get_commitment`, sent only to the contract the
 * request names. The offline tests and agents only ever construct the testnet flavour; mainnet is constructed by the operator.
 */
export class LivePreflightChain implements ChainWrite {
  readonly network: Network;
  private readonly url: string;
  private readonly rpc: NearReadOnlyRpc;
  constructor(network: "testnet" | "mainnet", url: string = NEAR_RPC[network]) {
    this.network = network;
    this.url = url;
    this.rpc = new NearReadOnlyRpc(url);
  }
  chainId() {
    return this.rpc.chainId();
  }
  async currentHeight(): Promise<number> {
    return ((await this.rpc.call("status", [])) as { sync_info: { latest_block_height: number } }).sync_info
      .latest_block_height;
  }
  async balance(account: string): Promise<bigint> {
    const r = (await this.rpc.call("query", {
      request_type: "view_account",
      finality: "final",
      account_id: account,
    })) as { amount: string };
    return BigInt(r.amount);
  }
  /** Gas price (yoctoNEAR per gas) times the 30 Tgas ceiling of the commitment call. */
  async estimateFee(_intent: TxIntent): Promise<bigint> {
    const g = (await this.rpc.call("gas_price", [null])) as { gas_price: string };
    return BigInt(g.gas_price) * 30_000_000_000_000n;
  }
  /** Read-only contract view at FINAL: is this payload hash already committed at the target? */
  async hasPayload(contract: string, payloadHash: string): Promise<boolean> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "release",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contract,
          method_name: "get_commitment",
          args_base64: Buffer.from(JSON.stringify({ hash: payloadHash })).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json()) as { result?: { result: number[] }; error?: unknown };
    if (!j.result) throw new Error("commitment view failed");
    return j.result.result.length === 8;
  }
  getTx: (hash: string) => Promise<TxRecord | null> = notRead("getTx");
  findByKey: (key: string) => Promise<TxRecord | null> = notRead("findByKey");
  listSignerTxs: (s: string, h: number) => Promise<TxRecord[]> = notRead("listSignerTxs");
  broadcast: (i: TxIntent) => Promise<{ hash: string }> = notRead("broadcast");
}

/** Real NEAR testnet reads for the pre-flight. */
export class LiveTestnetPreflightChain extends LivePreflightChain {
  constructor() {
    super("testnet");
  }
}
