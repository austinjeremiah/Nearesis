/** Minimal testnet JSON-RPC helpers used by the release scripts. Testnet only; nothing here prints or returns a key. */
export const TESTNET_RPC = "https://rpc.testnet.near.org";

export async function rpc<T = unknown>(method: string, params: unknown): Promise<T> {
  const r = await fetch(TESTNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(j.error).slice(0, 400)}`);
  return j.result as T;
}

export async function accessKeyNonceAndBlock(account: string, publicKey: string) {
  const k = await rpc<{ nonce: number; block_hash: string }>("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: account,
    public_key: publicKey,
  });
  return { nonce: BigInt(k.nonce), blockHash: k.block_hash };
}

export async function viewCommitment(
  contract: string,
  hash: string,
): Promise<{ present: boolean; timestampNs: string | null; blockHash: string }> {
  const r = await rpc<{ result: number[]; block_hash: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: "get_commitment",
    args_base64: Buffer.from(JSON.stringify({ hash })).toString("base64"),
  });
  const b = Buffer.from(r.result);
  return b.length === 8
    ? { present: true, timestampNs: b.readBigUInt64LE().toString(), blockHash: r.block_hash }
    : { present: false, timestampNs: null, blockHash: r.block_hash };
}
