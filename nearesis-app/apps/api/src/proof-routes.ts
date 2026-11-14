import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InsufficientCredits, KernelError, canWrite, chargeIn, holdIn, releaseIn } from "@nearesis/kernel";
import type { Db, Kernel, Session, TenantContext } from "@nearesis/kernel";
import {
  APP_ROOT,
  DEFAULT_LIMITS,
  DEFAULT_WASM,
  OUTLAYER_DEV_ACCOUNT,
  ProveRefused,
  ROOT_ENV_FILE,
  TESTNET_SPEND_FILE,
  TestnetOutlayerChain,
  appendSpendEntry,
  loadCapsuleForProof,
  loadOutlayerLivePolicy,
  proveCapsule,
  readCapsuleOwnership,
  remainingCapYocto,
} from "@nearesis/capsule";
import type { OutlayerChain, OutlayerProofDocument, SpendEntry } from "@nearesis/capsule";
import { resolveCapsuleDir } from "./capsule-resolve.ts";
import { PROOF_COLUMNS, readFileProof, rowToProof } from "./proof-view.ts";
import type { Proof, ProofRow } from "./proof-view.ts";
import { readManifest } from "@nearesis/capsule";

/** Gas attached to `request_execution` (TestnetOutlayerChain): the hold covers all of it at the current gas price. */
export const PROOF_GAS = 300_000_000_000_000n;

export type ProofChain = OutlayerChain & { gasPriceYocto(): Promise<string> };

export interface ProofRoutesOptions {
  /** Test seam: the chain client (default: TestnetOutlayerChain with the dev wallet key from the repo-root .env). */
  chainFactory?: () => ProofChain;
  /** Test seam: the prover (default: `proveCapsule`, the same live path as `pnpm research:prove --live`). */
  runProof?: typeof proveCapsule;
  /** Test seam: the 1 NEAR global testnet cap file (default `.data/spend/near-testnet.json`). */
  spendFile?: string;
  /** Test seam: the pinned verifier wasm. */
  wasmPath?: string;
}

const liveEnabled = () => process.env.NEARESIS_OUTLAYER_LIVE === "1";
const capsuleRoot = () => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
const proofOutRoot = () => join(process.env.NEARESIS_PROOF_DIR ?? join(APP_ROOT, ".data", "proofs"), "api");
const ctxOf = (s: Session): TenantContext => ({ orgId: s.principal.orgId, userId: s.userId });

const errBody = (
  req: FastifyRequest,
  errorCode: string,
  reasonCode: string,
  message: string,
  extra = {},
) => ({
  traceId: req.traceId,
  errorCode,
  reasonCode,
  message,
  retryable: false,
  ...extra,
});

/** Marks every proof left running by a previous process (see the rules on txHash in the file header of the migration). */
export async function recoverInterruptedProofs(db: Db): Promise<number> {
  const running = await db.txGlobal(async (tx) => {
    const r = await tx.query<{
      id: string;
      org_id: string;
      requested_by: string;
      tx_hash: string | null;
      held_yocto: string;
    }>("SELECT id, org_id, requested_by, tx_hash, held_yocto FROM outlayer_proofs_running()");
    return r.rows;
  });
  for (const p of running) {
    await db.tx({ orgId: p.org_id, userId: p.requested_by }, async (tx) => {
      if (p.tx_hash === null) {
        const held = BigInt(p.held_yocto);
        if (held > 0n)
          await releaseIn(tx, p.requested_by, held, {
            refKind: "proof",
            refId: p.id,
            detail: { reason: "interrupted before any transaction" },
          });
        await tx.query(
          "UPDATE outlayer_proofs SET state='failed', error='interrupted', total_yocto=0, finished_at=now() WHERE id=$1",
          [p.id],
        );
      } else {
        // The transaction may have been paid for: the hold stays until a human reconciles it.
        await tx.query(
          "UPDATE outlayer_proofs SET state='failed', error='interrupted after submission; needs reconciliation', finished_at=now() WHERE id=$1",
          [p.id],
        );
      }
    });
  }
  return running.length;
}

export interface ProofRoutes {
  /** Hold estimate for one proof (null when the provider is disabled or the chain cannot be read). */
  estimateFor(ctx: TenantContext, capsuleId?: string): Promise<string | null>;
}

export async function proofRoutes(
  app: FastifyInstance,
  opts: ProofRoutesOptions & { kernel: Kernel; authenticate(req: FastifyRequest): Promise<Session> },
): Promise<ProofRoutes> {
  const { kernel, authenticate } = opts;
  const spendFile = opts.spendFile ?? TESTNET_SPEND_FILE;
  const wasmPath = opts.wasmPath ?? DEFAULT_WASM;
  const makeChain = (): ProofChain =>
    opts.chainFactory?.() ??
    (new TestnetOutlayerChain({ account: OUTLAYER_DEV_ACCOUNT, envFile: ROOT_ENV_FILE }) as ProofChain);
  const inflight = new Set<Promise<void>>();

  try {
    await recoverInterruptedProofs(kernel.db);
  } catch {
    /* the proof tables may not be migrated yet; routes then fail on first use with a clear error */
  }

  const dirOf = (id: string): string | null => resolveCapsuleDir(capsuleRoot(), id);
  const visibleDir = async (s: Session, id: string): Promise<string | null> => {
    const d = dirOf(id);
    if (!d) return null;
    const owner = readCapsuleOwnership(d);
    if (!owner || owner.orgId !== s.principal.orgId) return null;
    try {
      await kernel.workspaces.get(s, owner.workspaceId);
    } catch (e) {
      if (e instanceof KernelError) return null;
      throw e;
    }
    return d;
  };
  const notFound = () => new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");

  const estimateCache = new Map<number, { at: number; value: string }>();
  async function estimate(chain: ProofChain, inputLen: number): Promise<bigint> {
    const hit = estimateCache.get(inputLen);
    if (hit && Date.now() - hit.at < 60_000) return BigInt(hit.value);
    const deposit = BigInt(await chain.estimateDeposit(DEFAULT_LIMITS, inputLen));
    const price = BigInt(await chain.gasPriceYocto());
    const v = deposit + PROOF_GAS * price;
    estimateCache.set(inputLen, { at: Date.now(), value: v.toString() });
    return v;
  }

  async function rowsOf(s: Session, capsuleId: string, limit = 50): Promise<ProofRow[]> {
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const r = await tx.query<ProofRow>(
        `SELECT ${PROOF_COLUMNS} FROM outlayer_proofs WHERE capsule_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
        [capsuleId, limit],
      );
      return r.rows;
    });
  }
  const fileProofOf = (dir: string, capsuleId: string) => {
    const m = readManifest(dir);
    return m ? readFileProof(dir, capsuleId, m.capsuleHash) : null;
  };

  async function inputLenOf(capsuleId?: string): Promise<number | null> {
    if (!capsuleId) return 0;
    const d = dirOf(capsuleId);
    if (!d) return null;
    try {
      return Buffer.byteLength(loadCapsuleForProof(d).inputData);
    } catch {
      return null;
    }
  }

  // ---- the background job ---------------------------------------------------------------------------------------------
  async function execute(
    s: Session,
    proofId: string,
    capsuleId: string,
    capsuleDir: string,
    chain: ProofChain,
    hold: bigint,
    budget: bigint,
  ): Promise<void> {
    const ctx = ctxOf(s);
    type Sent = {
      txHash: string;
      requestId: number | null;
      deposit: bigint | null;
      burnt: bigint;
      charged: bigint | null;
    };
    const rec: { v: Sent | null } = { v: null };
    const pending: Array<Promise<unknown>> = [];
    const ref = (detail: Record<string, unknown>) => ({
      refKind: "proof",
      refId: proofId,
      detail: { capsuleId, ...detail },
    });
    try {
      let doc: OutlayerProofDocument | null = null;
      let failure: string | null = null;
      try {
        doc = await (opts.runProof ?? proveCapsule)({
          capsuleDir,
          wasmPath,
          policy: loadOutlayerLivePolicy(),
          outDir: join(proofOutRoot(), proofId),
          live: {
            chain,
            budgetYocto: budget,
            recordSpend: (e: SpendEntry) => {
              rec.v = {
                txHash: e.txHash,
                requestId: e.requestId ?? null,
                deposit: e.depositYocto ? BigInt(e.depositYocto) : null,
                burnt: BigInt(e.burntYocto),
                charged: e.chargedYocto === null ? null : BigInt(e.chargedYocto),
              };
              pending.push(
                kernel.db
                  .tx(ctx, (tx) =>
                    tx.query("UPDATE outlayer_proofs SET tx_hash=$2, request_id=$3 WHERE id=$1", [
                      proofId,
                      e.txHash,
                      e.requestId === undefined ? null : String(e.requestId),
                    ]),
                  )
                  .catch(() => undefined),
              );
              pending.push(appendSpendEntry(e, chain, spendFile).catch(() => undefined));
            },
          },
        });
      } catch (e) {
        failure =
          e instanceof ProveRefused
            ? `${e.code}: ${e.message}`.slice(0, 500)
            : String((e as Error).message ?? e).slice(0, 500);
      }
      await Promise.all(pending);

      const job = doc?.job ?? null;
      const sentTx = rec.v;
      const txHash = job?.txHash ?? sentTx?.txHash ?? null;
      if (txHash === null) {
        // Failed before any transaction: nothing was spent, release the whole hold.
        await kernel.db.tx(ctx, async (tx) => {
          await releaseIn(
            tx,
            ctx.userId,
            hold,
            ref({ reason: "failed before any transaction", error: failure }),
          );
          await tx.query(
            "UPDATE outlayer_proofs SET state='failed', error=$2, total_yocto=0, finished_at=now() WHERE id=$1",
            [proofId, failure ?? "no job was submitted"],
          );
        });
        return;
      }
      const burnt = job ? BigInt(job.tokensBurntYocto) : sentTx!.burnt;
      const providerCharged = job
        ? job.chargedYocto === null
          ? null
          : BigInt(job.chargedYocto)
        : sentTx!.charged;
      const deposit = job ? BigInt(job.depositYocto) : sentTx!.deposit;
      // The provider's charge is unknown only when no completion event was seen: bill the full deposit then (the most the
      // wallet could have lost) and say so in the ledger detail.
      const chargedUnknown = providerCharged === null;
      const charged = providerCharged ?? deposit ?? 0n;
      const total = charged + burnt;
      const requestId = job
        ? String(job.requestId)
        : sentTx!.requestId === null
          ? null
          : String(sentTx!.requestId);
      const attested = doc?.labels.attestation === "attested";
      const state = failure !== null ? "failed" : attested ? "verified" : "not_attested";
      const v = doc?.verification ?? null;
      await kernel.db.tx(ctx, async (tx) => {
        await chargeIn(
          tx,
          ctx.userId,
          hold,
          total,
          ref({
            txHash,
            requestId,
            chargedYocto: charged.toString(),
            tokensBurntYocto: burnt.toString(),
            ...(chargedUnknown ? { chargedYoctoAssumed: "deposit (provider charge unknown)" } : {}),
          }),
        );
        await tx.query(
          `UPDATE outlayer_proofs SET state=$2, tx_hash=$3, request_id=$4, output_sha256=$5, decision=$6, reasons=$7::jsonb,
             mr_td=$8, rtmr3=$9, charged_yocto=$10, gas_yocto=$11, total_yocto=$12, error=$13, finished_at=now() WHERE id=$1`,
          [
            proofId,
            state,
            txHash,
            requestId,
            doc?.attestedOutputSha256 ?? null,
            v?.decision ?? null,
            JSON.stringify(v?.reasons ?? []),
            v?.mrTd ?? null,
            v?.rtmr3 ?? null,
            charged.toString(),
            burnt.toString(),
            total.toString(),
            failure,
          ],
        );
      });
    } catch (e) {
      // Settlement itself failed (database): leave the proof running so the next start reconciles it by the tx rule.
      void e;
    }
  }

  // ---- routes ---------------------------------------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/v1/capsules/:id/proofs", async (req, reply: FastifyReply) => {
    const s = await authenticate(req);
    const ctx = ctxOf(s);
    const capsuleId = req.params.id;
    const dir = await visibleDir(s, capsuleId);
    const owner = dir ? readCapsuleOwnership(dir) : null;
    if (!dir || !owner) throw notFound();
    if (!canWrite(s.role))
      throw new KernelError("FORBIDDEN", "ROLE_CANNOT_PROVE", "Viewers cannot request proofs.");
    const keyH = req.headers["idempotency-key"];
    const idemKey = typeof keyH === "string" ? keyH : undefined;
    if (idemKey !== undefined && (idemKey.length < 8 || idemKey.length > 200))
      throw new KernelError(
        "VALIDATION_FAILED",
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must be 8-200 characters.",
      );
    if (idemKey) {
      const prior = await kernel.db.tx(ctx, async (tx) => {
        const r = await tx.query<ProofRow>(
          `SELECT ${PROOF_COLUMNS} FROM outlayer_proofs WHERE requested_by = $1 AND idempotency_key = $2`,
          [ctx.userId, idemKey],
        );
        return r.rows[0];
      });
      if (prior)
        return reply
          .status(202)
          .send({ ...rowToProof(prior), proofId: prior.id, state: prior.state, replayed: true });
    }
    if (!liveEnabled())
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "PROOF_PROVIDER_DISABLED",
        "OutLayer proofs are not enabled on this server.",
        { retryable: false },
      );

    const alreadyDb = (await rowsOf(s, capsuleId, 20)).find((r) => r.state === "verified");
    const file = fileProofOf(dir, capsuleId);
    if (alreadyDb || file?.verified) {
      const proof = alreadyDb ? rowToProof(alreadyDb) : file!.proof;
      return reply.status(409).send(
        errBody(req, "STALE_VERSION", "ALREADY_PROVED", "This capsule already has a verified live proof.", {
          proof,
        }),
      );
    }

    let loaded: ReturnType<typeof loadCapsuleForProof>;
    try {
      loaded = loadCapsuleForProof(dir);
    } catch (e) {
      throw new KernelError(
        "VALIDATION_FAILED",
        e instanceof ProveRefused ? e.code : "CAPSULE_NOT_PROVABLE",
        "This capsule cannot be proved.",
      );
    }
    const wasmSha = loaded.manifest.computation.verifier.wasmSha256;
    if (!wasmSha)
      throw new KernelError(
        "VALIDATION_FAILED",
        "CAPSULE_NOT_PROVABLE",
        "This capsule has no pinned verifier.",
      );

    let chain: ProofChain;
    let hold: bigint;
    let remaining: bigint;
    try {
      chain = makeChain();
      hold = await estimate(chain, Buffer.byteLength(loaded.inputData));
      remaining = remainingCapYocto(spendFile);
    } catch {
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "PROOF_PROVIDER_UNAVAILABLE",
        "The OutLayer provider could not be reached or is not configured.",
      );
    }
    if (hold > remaining)
      return reply
        .status(409)
        .send(
          errBody(
            req,
            "STALE_VERSION",
            "TESTNET_CAP_REACHED",
            "The global testnet spend cap would be exceeded.",
            { remainingYocto: remaining.toString(), requiredYocto: hold.toString() },
          ),
        );

    const proofId = randomUUID();
    try {
      await kernel.db.tx(ctx, async (tx) => {
        await tx.query(
          `INSERT INTO outlayer_proofs(id, org_id, workspace_id, capsule_id, requested_by, idempotency_key, state, wasm_sha256, input_sha256, held_yocto)
           VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9)`,
          [
            proofId,
            owner.orgId,
            owner.workspaceId,
            capsuleId,
            ctx.userId,
            idemKey ?? null,
            wasmSha,
            loaded.manifest.computation.inputFile.sha256,
            hold.toString(),
          ],
        );
        await holdIn(tx, ctx.userId, hold, {
          refKind: "proof",
          refId: proofId,
          detail: { capsuleId, kind: "outlayer_proof" },
        });
      });
    } catch (e) {
      if (e instanceof InsufficientCredits)
        return reply
          .status(402)
          .send(
            errBody(
              req,
              "BUDGET_EXCEEDED",
              "INSUFFICIENT_CREDITS",
              "Not enough credits for an OutLayer proof.",
              { requiredYocto: e.requiredYocto.toString(), availableYocto: e.availableYocto.toString() },
            ),
          );
      if ((e as { code?: string }).code === "23505")
        throw new KernelError(
          "STALE_VERSION",
          "PROOF_IN_PROGRESS",
          "A proof for this capsule is already running.",
        );
      throw e;
    }
    const job = execute(s, proofId, capsuleId, dir, chain, hold, remaining).finally(() =>
      inflight.delete(job),
    );
    inflight.add(job);
    return reply.status(202).send({ proofId, state: "running" as const });
  });

  app.get<{ Params: { id: string } }>("/v1/capsules/:id/proofs", async (req) => {
    const s = await authenticate(req);
    const dir = await visibleDir(s, req.params.id);
    if (!dir) throw notFound();
    const items: Proof[] = (await rowsOf(s, req.params.id)).map(rowToProof);
    const f = fileProofOf(dir, req.params.id);
    if (f) items.push(f.proof);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items };
  });

  app.get<{ Params: { proofId: string } }>("/v1/proofs/:proofId", async (req) => {
    const s = await authenticate(req);
    const id = req.params.proofId;
    const nf = () => new KernelError("NOT_FOUND", "PROOF_NOT_FOUND", "Proof not found.");
    if (id.startsWith("file-")) {
      const cid = id.slice(5);
      const dir = await visibleDir(s, cid);
      const f = dir ? fileProofOf(dir, cid) : null;
      if (!f) throw nf();
      return f.proof;
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw nf();
    const row = await kernel.db.tx(ctxOf(s), async (tx) => {
      const r = await tx.query<ProofRow>(`SELECT ${PROOF_COLUMNS} FROM outlayer_proofs WHERE id = $1`, [id]);
      return r.rows[0];
    });
    if (!row) throw nf();
    return rowToProof(row);
  });

  return {
    async estimateFor(ctx, capsuleId) {
      void ctx;
      if (!liveEnabled()) return null;
      try {
        const len = await inputLenOf(capsuleId);
        if (len === null) return null;
        return (await estimate(makeChain(), len)).toString();
      } catch {
        return null;
      }
    },
  };
}
