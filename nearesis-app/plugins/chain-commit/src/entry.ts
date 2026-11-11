/**
 * chain-commit plugin (testnet only). One capability, `chain_commit.commit_hash@1`, writes a payload HASH to the
 * allowlisted testnet contract. The kernel gateway has already verified a human approval of this exact call before the
 * handler runs; the handler re-checks the policy, asks the signer process for a signature (it never sees a key), and
 * submits through the declared RPC endpoint (`ctx.egress` for any public host). The signer and RPC endpoints come from the
 * manifest-declared `networkHosts`, published to the handler as configuration constants below.
 */
import { request as httpRequest } from "node:http";
import { definePlugin, type InvocationContext } from "@nearesis/plugin-sdk";
import { checkPolicy, type CommitTx } from "./policy.ts";

export const CAPABILITY = "chain_commit.commit_hash@1";

/** Endpoints are read from the environment of the HOST at call time; neither value is a secret (loopback ports). */
function endpoints(): { signer: string; rpc: string } {
  const signer = process.env.CHAIN_COMMIT_SIGNER_URL;
  const rpc = process.env.CHAIN_COMMIT_RPC_URL;
  if (!signer || !rpc) throw new Error("CHAIN_COMMIT_NOT_CONFIGURED");
  return { signer, rpc };
}

interface Reply {
  status: number;
  body: Uint8Array;
}

/**
 * Loopback endpoints (the signer process and a local chain fixture) are reached over node:http, which the kernel's
 * confinement permits only for the exact `ip:port` pairs of this plugin's signed manifest. Every other destination (the
 * public testnet RPC) goes through the SSRF-filtered, allowlisted `ctx.egress`.
 */
async function post(url: string, body: string, ctx: InvocationContext): Promise<Reply> {
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1")
    return ctx.egress(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: Number(u.port),
        path: u.pathname,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    ctx.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    req.end(body);
  });
}

/** Live testnet path: real nonce and block hash from the RPC, borsh transaction signed by the signer process, broadcast. */
async function commitLive(tx: CommitTx, signer: string, rpc: string, ctx: InvocationContext) {
  const json = async (r: Reply) => JSON.parse(Buffer.from(r.body).toString("utf8")) as any;
  const pk = await json(await post(signer, JSON.stringify({ op: "pubkey" }), ctx));
  const key = await json(
    await post(
      rpc,
      JSON.stringify({
        jsonrpc: "2.0",
        id: ctx.requestId,
        method: "query",
        params: {
          request_type: "view_access_key",
          finality: "final",
          account_id: pk.signerId,
          public_key: pk.publicKey,
        },
      }),
      ctx,
    ),
  );
  if (!key.result) throw new Error("RPC_NO_ACCESS_KEY");
  const s = await post(
    signer,
    JSON.stringify({ tx, nonce: String(BigInt(key.result.nonce) + 1n), blockHash: key.result.block_hash }),
    ctx,
  );
  if (s.status !== 200) throw new Error(`SIGNER_REFUSED_${s.status}`);
  const { digest, signedTx } = await json(s);
  const sent = await json(
    await post(
      rpc,
      JSON.stringify({
        jsonrpc: "2.0",
        id: ctx.requestId,
        method: "broadcast_tx_commit",
        params: [signedTx],
      }),
      ctx,
    ),
  );
  if (!sent.result) throw new Error(`RPC_FAILED_${JSON.stringify(sent.error ?? {}).slice(0, 200)}`);
  return {
    committed: sent.result.status && "SuccessValue" in sent.result.status,
    network: tx.network,
    digest,
    txHash: sent.result.transaction?.hash ?? null,
  };
}

export default definePlugin({
  handlers: {
    [CAPABILITY]: async (input: unknown, ctx: InvocationContext) => {
      const violation = checkPolicy(input);
      if (violation) throw new Error(violation); // defence in depth: the schema already refused this
      const tx = input as CommitTx;
      const { signer, rpc } = endpoints();
      if (process.env.CHAIN_COMMIT_LIVE === "1") return commitLive(tx, signer, rpc, ctx);
      const signed = await post(signer, JSON.stringify({ tx }), ctx);
      if (signed.status !== 200) throw new Error(`SIGNER_REFUSED_${signed.status}`);
      const { digest, signature } = JSON.parse(Buffer.from(signed.body).toString("utf8")) as {
        digest: string;
        signature: string;
      };
      const sent = await post(
        rpc,
        JSON.stringify({
          jsonrpc: "2.0",
          id: ctx.requestId,
          method: "broadcast_tx_commit",
          params: { tx, digest, signature },
        }),
        ctx,
      );
      if (sent.status !== 200) throw new Error(`RPC_FAILED_${sent.status}`);
      const out = JSON.parse(Buffer.from(sent.body).toString("utf8")) as { result?: { hash?: string } };
      return { committed: true, network: tx.network, digest, txHash: out.result?.hash ?? null };
    },
  },
  health: () => undefined,
});
