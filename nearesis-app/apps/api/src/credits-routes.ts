import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CreditsService, KernelError, topupIn, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session, TenantContext } from "@nearesis/kernel";
import { proofRoutes } from "./proof-routes.ts";
import type { ProofRoutesOptions } from "./proof-routes.ts";

/** What the topup check needs from a final testnet transaction (a subset of the node's `EXPERIMENTAL_tx_status`). */
export interface TxStatus {
  final_execution_status?: string;
  status: Record<string, unknown>;
  transaction: { signer_id: string; receiver_id: string; actions: Array<Record<string, unknown>> };
  receipts_outcome?: Array<{ outcome: { status: Record<string, unknown> } }>;
}
/** Test seam. Returns null when the node does not know the transaction. */
export type FetchTx = (txHash: string, senderAccountId: string) => Promise<TxStatus | null>;

export const nearRpc = (): string => process.env.NEARESIS_NEAR_RPC ?? "https://rpc.testnet.near.org";
export const depositAccount = (): string =>
  process.env.NEARESIS_CREDIT_DEPOSIT_ACCOUNT ?? "majorlynx5104.testnet";

export const rpcFetchTx: FetchTx = async (txHash, sender) => {
  const r = await fetch(nearRpc(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "EXPERIMENTAL_tx_status",
      params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json()) as {
    result?: TxStatus;
    error?: { name?: string; cause?: { name?: string }; data?: unknown };
  };
  if (j.error) {
    const cause = j.error.cause?.name ?? "";
    if (cause === "UNKNOWN_TRANSACTION" || cause === "TIMEOUT_ERROR" || cause === "INVALID_TRANSACTION")
      return null;
    throw new Error(`RPC error ${j.error.name ?? ""} ${cause}`.trim());
  }
  return j.result ?? null;
};

const TopupBody = z.strictObject({ txHash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) });
const failed = (s: Record<string, unknown> | undefined) => !!s && "Failure" in s;

const reject = (reasonCode: string, message: string) =>
  new KernelError("VALIDATION_FAILED", reasonCode, message);

/** Pure decision: the credited amount, or a typed 422. */
export function judgeTopup(tx: TxStatus | null, signer: string, receiver: string): bigint {
  if (!tx) throw reject("TX_NOT_FOUND", "The transaction was not found on testnet.");
  if (tx.final_execution_status !== undefined && tx.final_execution_status !== "FINAL")
    throw reject("TX_NOT_FOUND", "The transaction is not final yet.");
  if (failed(tx.status) || (tx.receipts_outcome ?? []).some((r) => failed(r.outcome.status)))
    throw reject("TX_FAILED", "The transaction did not succeed.");
  if (tx.transaction.signer_id !== signer)
    throw reject("WRONG_SIGNER", "The transaction was not signed by your linked NEAR account.");
  if (tx.transaction.receiver_id !== receiver)
    throw reject("WRONG_RECEIVER", `The transaction was not sent to ${receiver}.`);
  let sum = 0n;
  const acts = tx.transaction.actions;
  if (acts.length === 0) throw reject("NOT_A_TRANSFER", "The transaction has no actions.");
  for (const a of acts) {
    const t = (a as { Transfer?: { deposit?: unknown } }).Transfer;
    if (Object.keys(a).length !== 1 || !t || typeof t.deposit !== "string" || !/^\d+$/.test(t.deposit))
      throw reject("NOT_A_TRANSFER", "Only plain transfers can be credited.");
    sum += BigInt(t.deposit);
  }
  if (sum <= 0n) throw reject("NOT_A_TRANSFER", "The transfer amount is zero.");
  return sum;
}

export interface CreditsRoutesOptions extends ProofRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam for the testnet transaction lookup (default: `EXPERIMENTAL_tx_status` with wait_until FINAL). */
  fetchTx?: FetchTx;
}

export const ctxOf = (s: Session): TenantContext => ({ orgId: s.principal.orgId, userId: s.userId });

/**
 * Credits: GET /v1/credits, POST /v1/credits/topups, plus the paid OutLayer proof routes (proof-routes.ts).
 * Amounts are exact yoctoNEAR decimal strings.
 */
export const creditsRoutes: FastifyPluginAsync<CreditsRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate } = opts;
  const credits = new CreditsService(kernel.db);
  const nearAccountOf = (ctx: TenantContext): Promise<string | null> =>
    kernel.db.tx(ctx, async (tx) => {
      const r = await tx.query<{ near_account_id: string | null }>(
        "SELECT near_account_id FROM users WHERE id = $1",
        [ctx.userId],
      );
      return r.rows[0]?.near_account_id ?? null;
    });

  const proofs = await proofRoutes(app, opts);

  async function creditsBody(ctx: TenantContext, capsuleId?: string) {
    const [acct, entries, accountId, est] = await Promise.all([
      credits.account(ctx),
      credits.entries(ctx, 50),
      nearAccountOf(ctx),
      proofs.estimateFor(ctx, capsuleId),
    ]);
    return {
      accountId,
      balanceYocto: acct.balanceYocto.toString(),
      heldYocto: acct.heldYocto.toString(),
      availableYocto: acct.availableYocto.toString(),
      depositAccount: depositAccount(),
      network: "testnet" as const,
      proofEstimateYocto: est,
      entries,
    };
  }

  app.get<{ Querystring: { capsuleId?: string } }>("/v1/credits", async (req) => {
    const s = await authenticate(req);
    const cap = typeof req.query.capsuleId === "string" ? req.query.capsuleId.slice(0, 200) : undefined;
    return creditsBody(ctxOf(s), cap);
  });

  app.post("/v1/credits/topups", async (req, reply: FastifyReply) => {
    const s = await authenticate(req);
    const ctx = ctxOf(s);
    const p = TopupBody.safeParse(req.body);
    if (!p.success)
      throw new KernelError(
        "VALIDATION_FAILED",
        "INVALID_BODY",
        "txHash must be a base58 transaction hash.",
        {
          details: zodDetails(p.error),
        },
      );
    const account = await nearAccountOf(ctx);
    if (!account)
      throw new KernelError("STALE_VERSION", "NO_NEAR_ACCOUNT", "Link a NEAR account before adding credits.");
    if (await credits.hasTopup(ctx, p.data.txHash))
      throw new KernelError(
        "STALE_VERSION",
        "TOPUP_ALREADY_CREDITED",
        "This transaction was already credited.",
      );
    const to = depositAccount();
    let tx: TxStatus | null;
    try {
      tx = await (opts.fetchTx ?? rpcFetchTx)(p.data.txHash, account);
    } catch {
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "NEAR_RPC_UNAVAILABLE",
        "The NEAR testnet RPC is unavailable.",
      );
    }
    const amount = judgeTopup(tx, account, to);
    await kernel.db.tx(ctx, (t) =>
      topupIn(t, ctx.userId, amount, {
        txHash: p.data.txHash,
        signerAccountId: account,
        receiverAccountId: to,
      }),
    );
    void reply.status(200);
    return creditsBody(ctx);
  });
};
