import { NearReadOnlyRpc } from "./chain.ts";
import type { ChainWrite, TxIntent, TxRecord } from "./chain.ts";
import { viewCommitment } from "../../plugins/chain-commit/src/rpc.ts";

const notRead = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available on the read-only live pre-flight chain`);
};

/** Real NEAR testnet reads for the pre-flight (chain id, balance, fee estimate). It cannot broadcast or look up txs. */
export class LiveTestnetPreflightChain implements ChainWrite {
  readonly network = "testnet" as const;
  private readonly rpc = new NearReadOnlyRpc("https://rpc.testnet.near.org");
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
    return (await viewCommitment(contract, payloadHash)).present;
  }
  getTx: (hash: string) => Promise<TxRecord | null> = notRead("getTx");
  findByKey: (key: string) => Promise<TxRecord | null> = notRead("findByKey");
  listSignerTxs: (s: string, h: number) => Promise<TxRecord[]> = notRead("listSignerTxs");
  broadcast: (i: TxIntent) => Promise<{ hash: string }> = notRead("broadcast");
}
