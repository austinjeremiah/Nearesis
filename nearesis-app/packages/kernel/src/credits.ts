import type { Db, Tx, TenantContext } from "./db/pool.ts";
import { KernelError } from "./errors.ts";

/**
 * Per-user credits in yoctoNEAR (exact integers). `available = balance - held`. Every operation locks the account row
 * with SELECT ... FOR UPDATE inside one transaction, does its arithmetic in bigint and writes the result back, so two
 * concurrent holds can never overdraw (the CHECK constraints in migration 022 are the backstop). The account row is created
 * lazily on the first write; a read of a user without one reports zeros without writing.
 */
export interface CreditAccount {
  balanceYocto: bigint;
  heldYocto: bigint;
  availableYocto: bigint;
}
export type CreditEntryKind = "topup" | "hold" | "charge" | "release";
export interface CreditEntry {
  id: string;
  kind: CreditEntryKind;
  amountYocto: string;
  refKind: string | null;
  refId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}
export interface CreditRef {
  refKind: string;
  refId: string;
  detail?: Record<string, unknown>;
}

/** Thrown by `hold` when available credits are below the amount. */
export class InsufficientCredits extends KernelError {
  constructor(
    readonly requiredYocto: bigint,
    readonly availableYocto: bigint,
  ) {
    super("BUDGET_EXCEEDED", "INSUFFICIENT_CREDITS", "Not enough credits for this operation.");
  }
}

const big = (v: unknown): bigint => BigInt(String(v));

async function lockAccount(tx: Tx, userId: string): Promise<{ balance: bigint; held: bigint }> {
  await tx.query(
    "INSERT INTO credit_accounts(user_id, balance_yocto, held_yocto) VALUES ($1, 0, 0) ON CONFLICT (user_id) DO NOTHING",
    [userId],
  );
  const r = await tx.query<{ balance_yocto: string; held_yocto: string }>(
    "SELECT balance_yocto, held_yocto FROM credit_accounts WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  const row = r.rows[0];
  if (!row)
    throw new KernelError("INTERNAL", "CREDIT_ACCOUNT_MISSING", "Credit account could not be locked.");
  return { balance: big(row.balance_yocto), held: big(row.held_yocto) };
}

async function writeAccount(tx: Tx, userId: string, balance: bigint, held: bigint): Promise<void> {
  await tx.query(
    "UPDATE credit_accounts SET balance_yocto = $2, held_yocto = $3, updated_at = now() WHERE user_id = $1",
    [userId, balance.toString(), held.toString()],
  );
}

async function entry(
  tx: Tx,
  userId: string,
  kind: CreditEntryKind,
  amount: bigint,
  ref: CreditRef | undefined,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    "INSERT INTO credit_entries(user_id, kind, amount_yocto, ref_kind, ref_id, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id",
    [
      userId,
      kind,
      amount.toString(),
      ref?.refKind ?? null,
      ref?.refId ?? null,
      JSON.stringify({ ...(ref?.detail ?? {}), ...extra }),
    ],
  );
  return r.rows[0]!.id;
}

const positive = (v: bigint, what: string) => {
  if (v <= 0n) throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", `${what} must be positive.`);
};

/** Reads the account without writing (zeros when none exists yet). */
export async function readAccountIn(tx: Tx, userId: string): Promise<CreditAccount> {
  const r = await tx.query<{ balance_yocto: string; held_yocto: string }>(
    "SELECT balance_yocto, held_yocto FROM credit_accounts WHERE user_id = $1",
    [userId],
  );
  const balance = r.rows[0] ? big(r.rows[0].balance_yocto) : 0n;
  const held = r.rows[0] ? big(r.rows[0].held_yocto) : 0n;
  return { balanceYocto: balance, heldYocto: held, availableYocto: balance - held };
}

/** Moves `amount` from available to held. Throws InsufficientCredits when available < amount. */
export async function holdIn(tx: Tx, userId: string, amount: bigint, ref: CreditRef): Promise<string> {
  positive(amount, "hold amount");
  const a = await lockAccount(tx, userId);
  const available = a.balance - a.held;
  if (available < amount) throw new InsufficientCredits(amount, available);
  await writeAccount(tx, userId, a.balance, a.held + amount);
  return entry(tx, userId, "hold", amount, ref);
}

/**
 * Settles a hold: the held amount is dropped and `actual` is deducted from the balance; the remainder is released. If
 * `actual` exceeds the hold, the excess is taken from available credits up to what the user has (the rest is recorded as
 * `shortfallYocto` and never drives the balance negative).
 */
export async function chargeIn(
  tx: Tx,
  userId: string,
  held: bigint,
  actual: bigint,
  ref: CreditRef,
): Promise<{ chargedYocto: bigint; releasedYocto: bigint; shortfallYocto: bigint }> {
  if (held < 0n || actual < 0n)
    throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", "Negative amount.");
  const a = await lockAccount(tx, userId);
  if (a.held < held)
    throw new KernelError("INTERNAL", "HOLD_NOT_FOUND", "The account holds less than the amount to settle.");
  const available = a.balance - a.held;
  const cap = held + available;
  const charged = actual < cap ? actual : cap;
  const released = held > charged ? held - charged : 0n;
  const shortfall = actual - charged;
  await writeAccount(tx, userId, a.balance - charged, a.held - held);
  await entry(
    tx,
    userId,
    "charge",
    charged,
    ref,
    shortfall > 0n ? { shortfallYocto: shortfall.toString() } : {},
  );
  if (released > 0n) await entry(tx, userId, "release", released, ref);
  return { chargedYocto: charged, releasedYocto: released, shortfallYocto: shortfall };
}

/** Returns a whole hold to available credits. */
export async function releaseIn(tx: Tx, userId: string, held: bigint, ref: CreditRef): Promise<void> {
  positive(held, "release amount");
  const a = await lockAccount(tx, userId);
  if (a.held < held)
    throw new KernelError("INTERNAL", "HOLD_NOT_FOUND", "The account holds less than the amount to release.");
  await writeAccount(tx, userId, a.balance, a.held - held);
  await entry(tx, userId, "release", held, ref);
}

/** Credits a topup. The transaction hash is credited once, ever: a repeat throws 409 TOPUP_ALREADY_CREDITED. */
export async function topupIn(
  tx: Tx,
  userId: string,
  amount: bigint,
  t: { txHash: string; signerAccountId: string; receiverAccountId: string },
): Promise<void> {
  positive(amount, "topup amount");
  const ins = await tx.query(
    `INSERT INTO credit_topups(tx_hash, user_id, amount_yocto, signer_account_id, receiver_account_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash`,
    [t.txHash, userId, amount.toString(), t.signerAccountId, t.receiverAccountId],
  );
  if (ins.rowCount === 0)
    throw new KernelError(
      "STALE_VERSION",
      "TOPUP_ALREADY_CREDITED",
      "This transaction was already credited.",
    );
  const a = await lockAccount(tx, userId);
  await writeAccount(tx, userId, a.balance + amount, a.held);
  await entry(tx, userId, "topup", amount, { refKind: "tx", refId: t.txHash, detail: { txHash: t.txHash } });
}

export class CreditsService {
  constructor(private readonly db: Db) {}
  account(ctx: TenantContext): Promise<CreditAccount> {
    return this.db.tx(ctx, (tx) => readAccountIn(tx, ctx.userId));
  }
  hold(ctx: TenantContext, amount: bigint, ref: CreditRef): Promise<string> {
    return this.db.tx(ctx, (tx) => holdIn(tx, ctx.userId, amount, ref));
  }
  charge(ctx: TenantContext, held: bigint, actual: bigint, ref: CreditRef) {
    return this.db.tx(ctx, (tx) => chargeIn(tx, ctx.userId, held, actual, ref));
  }
  release(ctx: TenantContext, held: bigint, ref: CreditRef): Promise<void> {
    return this.db.tx(ctx, (tx) => releaseIn(tx, ctx.userId, held, ref));
  }
  topup(
    ctx: TenantContext,
    amount: bigint,
    t: { txHash: string; signerAccountId: string; receiverAccountId: string },
  ): Promise<void> {
    return this.db.tx(ctx, (tx) => topupIn(tx, ctx.userId, amount, t));
  }
  /** True when this transaction hash was already credited to the caller. */
  async hasTopup(ctx: TenantContext, txHash: string): Promise<boolean> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query("SELECT 1 FROM credit_topups WHERE tx_hash = $1", [txHash]);
      return (r.rowCount ?? 0) > 0;
    });
  }
  entries(ctx: TenantContext, limit = 50): Promise<CreditEntry[]> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<{
        id: string;
        kind: CreditEntryKind;
        amount_yocto: string;
        ref_kind: string | null;
        ref_id: string | null;
        detail: Record<string, unknown>;
        created_at: Date;
      }>(
        "SELECT id, kind, amount_yocto, ref_kind, ref_id, detail, created_at FROM credit_entries WHERE user_id = $1 ORDER BY seq DESC LIMIT $2",
        [ctx.userId, limit],
      );
      return r.rows.map((x) => ({
        id: x.id,
        kind: x.kind,
        amountYocto: x.amount_yocto,
        refKind: x.ref_kind,
        refId: x.ref_id,
        detail: x.detail,
        createdAt: x.created_at.toISOString(),
      }));
    });
  }
}
