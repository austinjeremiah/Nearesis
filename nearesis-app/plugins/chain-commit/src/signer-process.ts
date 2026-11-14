/**
 * The signer: a separate process that alone holds the testnet signing key. The key is handed over on stdin as one line of
 * PKCS8 PEM, base64 encoded, and is never placed in an environment variable, argument, file or response. It listens on an
 * ephemeral loopback port, prints `PORT <n>` once ready, and signs only transactions inside the commitment policy.
 * Run it with an empty environment: `node signer-process.ts`.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { baseDecode, baseEncode } from "@near-js/utils";
import { assembleSigned, buildCommitTransaction } from "./near-tx.ts";
import { checkPolicy, SIGNER_ACCOUNT, type CommitTx } from "./policy.ts";

const rl = createInterface({ input: process.stdin });
const first: string = await new Promise((resolve) => rl.once("line", resolve));
const key = createPrivateKey(Buffer.from(first.trim(), "base64").toString("utf8"));
rl.close();

const publicKey = `ed25519:${baseEncode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32))}`;

const canonical = (t: CommitTx) =>
  JSON.stringify({
    network: t.network,
    contract: t.contract,
    method: t.method,
    payloadHash: t.payloadHash,
    depositYocto: t.depositYocto,
    gas: t.gas,
  });

const stats = { signed: 0, refused: 0 };
createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stats));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.length < 64 && chunks.push(c));
  req.on("end", () => {
    const reply = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        op?: string;
        tx?: unknown;
        nonce?: string;
        blockHash?: string;
      };
      if (body.op === "pubkey") return reply(200, { publicKey, signerId: SIGNER_ACCOUNT });
      const tx = body.tx;
      const violation = checkPolicy(tx);
      if (violation) {
        stats.refused++;
        return reply(403, { error: "POLICY_VIOLATION", reason: violation });
      }
      if (body.nonce !== undefined && body.blockHash !== undefined) {
        // Real NEAR transaction: borsh-encoded FunctionCall, policy-checked inside buildCommitTransaction.
        const u = buildCommitTransaction(tx as CommitTx, {
          signerId: SIGNER_ACCOUNT,
          publicKey,
          nonce: BigInt(body.nonce),
          blockHash: baseDecode(body.blockHash),
        });
        const signature = sign(null, u.digest, key);
        stats.signed++;
        return reply(200, {
          digest: Buffer.from(u.digest).toString("hex"),
          signature: signature.toString("base64"),
          signedTx: Buffer.from(assembleSigned(u, signature)).toString("base64"),
        });
      }
      const bytes = Buffer.from(canonical(tx as CommitTx));
      const digest = createHash("sha256").update(bytes).digest();
      stats.signed++;
      reply(200, { digest: digest.toString("hex"), signature: sign(null, digest, key).toString("base64") });
    } catch {
      reply(400, { error: "BAD_REQUEST" });
    }
  });
}).listen(0, "127.0.0.1", function (this: import("node:net").Server) {
  const a = this.address();
  process.stdout.write(`PORT ${typeof a === "object" && a ? a.port : 0}\n`);
});
