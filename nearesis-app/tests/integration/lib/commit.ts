/**
 * Lifecycle step 12 (commit): the capsule hash is committed through the REAL path of ch.12: the chain-commit plugin
 * installed in the kernel under production trust, a kernel capability lease for the agent, an owner approval bound to the
 * exact call, the kernel gateway, and the signer process (the key never leaves it).
 *  - `fixture`: the chain is a loopback JSON-RPC fixture that verifies the signature against a locally generated key.
 *  - `live`: NEAR testnet, account majorlynx5104.testnet, contract commit.majorlynx5104.testnet, method commit_hash, key from
 *    the repo-root .env (read into the signer process only). The transaction is read back at FINAL.
 * Mainnet, transfers and other contracts are refused by the same policy in three places (schema, handler, signer).
 */
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../../../packages/plugin-sdk/src/index.ts";
import type { ExecutionRequest } from "../../../packages/contracts/src/index.ts";
import {
  APP_ROOT,
  TEST_PUBLISHER,
  type KernelEnv,
} from "../../../packages/agent-runtime/src/testing/kernel-env.ts";
import { grant } from "../../../packages/kernel/test/helpers/index.ts";
import {
  ALLOWED_CONTRACT,
  ALLOWED_METHOD,
  CAPABILITY,
  ENTRY_FILE,
  buildManifest,
  startSigner,
} from "../../../plugins/chain-commit/src/index.ts";
import { readbackLive, signerPemFromEnv } from "../../../plugins/chain-commit/src/live.ts";
import { recordTestnetSpend, testnetBalanceYocto } from "../../../plugins/chain-commit/src/spend.ts";

export interface CommitOutcome {
  mode: "fixture" | "live";
  payloadHash: string;
  txHash: string | null;
  contract: string;
  method: string;
  approvalActionHash: string;
  /** Live: the FINAL transaction status and the contract view; fixture: the loopback chain's record. */
  readback: Record<string, unknown>;
  /** Live only: testnet balance spent by this commit, in yoctoNEAR, and the ledger entry written. */
  spentYocto?: string;
}

/** The task budget for testnet spend (brief: at most 0.01 NEAR). */
export const COMMIT_BUDGET_YOCTO = 10n ** 22n;
const ENV_FILE = join(APP_ROOT, "..", ".env");
export const TESTNET_LEDGER = join(APP_ROOT, ".data", "spend", "near-testnet.json");

export async function commitThroughGateway(a: {
  kernel: KernelEnv;
  workspaceId: string;
  runId: string;
  payloadHash: string;
  mode: "fixture" | "live";
  note: string;
}): Promise<CommitOutcome> {
  const k = a.kernel;
  if (!/^[0-9a-f]{64}$/.test(a.payloadHash)) throw new Error("payload must be a 64-hex hash");
  const rpcLog: Array<{ tx: Record<string, unknown>; ok: boolean }> = [];
  let rpcServer: Server | undefined;
  const keys = generateKeyPairSync("ed25519");
  const fixturePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const signer = await startSigner(a.mode === "live" ? signerPemFromEnv(ENV_FILE) : fixturePem);
  const saved = { ...process.env };
  try {
    let rpcHost: string;
    let balanceBefore = 0n;
    if (a.mode === "live") {
      balanceBefore = BigInt(await testnetBalanceYocto());
      if (balanceBefore < 10n * COMMIT_BUDGET_YOCTO)
        throw new Error("testnet balance too low for the commit");
      process.env.CHAIN_COMMIT_RPC_URL = "https://rpc.testnet.near.org";
      process.env.CHAIN_COMMIT_LIVE = "1";
      rpcHost = "rpc.testnet.near.org";
    } else {
      const pub = createPublicKey(keys.publicKey.export({ format: "pem", type: "spki" }));
      rpcServer = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id: string;
            params: { tx: Record<string, unknown>; digest: string; signature: string };
          };
          const digest = createHash("sha256").update(JSON.stringify(body.params.tx)).digest();
          const ok =
            digest.toString("hex") === body.params.digest &&
            verify(null, digest, pub, Buffer.from(body.params.signature, "base64"));
          rpcLog.push({ tx: body.params.tx, ok });
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { hash: `fixture-tx-${rpcLog.length}` },
            }),
          );
        });
      });
      await new Promise<void>((r) => rpcServer!.listen(0, "127.0.0.1", r));
      const port = (rpcServer.address() as { port: number }).port;
      process.env.CHAIN_COMMIT_RPC_URL = `http://127.0.0.1:${port}/`;
      delete process.env.CHAIN_COMMIT_LIVE;
      rpcHost = `127.0.0.1:${port}`;
    }
    process.env.CHAIN_COMMIT_SIGNER_URL = `http://127.0.0.1:${signer.port}/sign`;

    await k.installPlugin(
      buildManifest({ publisher: TEST_PUBLISHER, networkHosts: [`127.0.0.1:${signer.port}`, rpcHost] }),
      ENTRY_FILE,
    );
    // chain writes are permitted only in a near-testnet workspace (kernel rule): the commit gets its own, beside the research one
    const chain = await k.kernel.workspaces.create(k.session, {
      objective: `chain commitment for run ${a.runId}`,
      networkScope: "near-testnet",
      idempotencyKey: `commit-${randomUUID()}`,
    });
    await k.kernel.commands.execute(k.session, chain.workspaceId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "plugin.enable",
      payload: { pluginId: "chain-commit" },
      expectedVersion: chain.version,
    });
    const workspaceId = chain.workspaceId;

    const input = {
      network: "near-testnet",
      contract: ALLOWED_CONTRACT,
      method: ALLOWED_METHOD,
      payloadHash: a.payloadHash,
      depositYocto: "0",
      gas: 30_000_000_000_000,
    };
    const actionHash = sha256Hex(canonicalJson({ capability: CAPABILITY, input }));
    const agentId = randomUUID();
    await k.kernel.leases.issue(k.session, {
      workspaceId,
      holderActorId: agentId,
      capability: CAPABILITY,
      grants: [grant({ resource: "chain", action: "commit" })],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // the owner approves this exact call for this run (the approval API is the human step; here it is the owner session)
    await k.kernel.db.tx({ orgId: k.orgId, userId: k.userId }, (tx) =>
      k.kernel.approvals.grant(tx, {
        orgId: k.orgId,
        workspaceId,
        runId: a.runId,
        actionHash,
        approvedBy: k.userId,
      }),
    );
    const principal = { kind: "agent", actorId: agentId, orgId: k.orgId, parentRunId: a.runId } as const;
    const res = await k.kernel.gateway.invoke(principal, {
      requestId: randomUUID(),
      idempotencyKey: `idem-${randomUUID()}`,
      tenantId: k.orgId,
      workspaceId,
      actor: { kind: "agent", actorId: agentId, parentRunId: a.runId },
      capability: CAPABILITY,
      input,
      deadlineMs: a.mode === "live" ? 90_000 : 10_000,
      trace: { traceId: randomUUID() },
    } as unknown as ExecutionRequest);
    const out = JSON.stringify(res);
    if (res.state !== "ok") throw new Error(`commit refused by the gateway: ${out.slice(0, 300)}`);
    const txHash = /"txHash":"([A-Za-z0-9-]+)"/.exec(out)?.[1] ?? null;
    if (!txHash) throw new Error("commit returned no transaction hash");

    if (a.mode === "fixture") {
      if (rpcLog.length !== 1 || !rpcLog[0]!.ok)
        throw new Error("fixture chain did not record one valid signature");
      return {
        mode: "fixture",
        payloadHash: a.payloadHash,
        txHash,
        contract: ALLOWED_CONTRACT,
        method: ALLOWED_METHOD,
        approvalActionHash: actionHash,
        readback: { chainCalls: rpcLog.length, signatureVerified: rpcLog[0]!.ok, tx: rpcLog[0]!.tx },
      };
    }
    let rb: Awaited<ReturnType<typeof readbackLive>> | undefined;
    let rbError: unknown;
    try {
      rb = await readbackLive(txHash, a.payloadHash);
    } catch (e) {
      rbError = e;
    }
    // the ledger entry is written whatever the readback says: the transaction exists and cost gas
    const balanceAfter = BigInt(await testnetBalanceYocto());
    const spent = balanceBefore - balanceAfter;
    await recordTestnetSpend(
      TESTNET_LEDGER,
      {
        method: `${ALLOWED_METHOD} (${ALLOWED_CONTRACT}) via kernel gateway`,
        txHash,
        depositNear: "0",
        note: `${a.note}; payload ${a.payloadHash}; task spend ${spent} yoctoNEAR`,
      },
      balanceAfter.toString(),
    );
    if (!rb) throw rbError;
    if (rb.finality !== "FINAL" || !rb.succeeded || !rb.equal)
      throw new Error(`testnet readback failed: ${JSON.stringify(rb)}`);
    if (spent > COMMIT_BUDGET_YOCTO)
      throw new Error(`testnet commit spent ${spent} yocto, above the 0.01 NEAR budget`);
    return {
      mode: "live",
      payloadHash: a.payloadHash,
      txHash,
      contract: rb.receiver,
      method: rb.method,
      approvalActionHash: actionHash,
      readback: rb as unknown as Record<string, unknown>,
      spentYocto: spent.toString(),
    };
  } finally {
    signer.stop();
    await new Promise<void>((r) => (rpcServer ? rpcServer.close(() => r()) : r()));
    for (const key of ["CHAIN_COMMIT_SIGNER_URL", "CHAIN_COMMIT_RPC_URL", "CHAIN_COMMIT_LIVE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
