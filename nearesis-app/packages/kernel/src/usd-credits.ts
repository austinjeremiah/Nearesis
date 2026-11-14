import type { Db, Tx, TenantContext } from "./db/pool.ts";
import { KernelError } from "./errors.ts";

/**
 * Unified per-user USD credits (migration 024). Amounts are integer micro-USD (bigint, never floats). `available =
 * granted - spent - held`. The account is created lazily with the allowance on first use (one `grant` entry), for new and
 * existing users alike. Every operation locks the account row (SELECT ... FOR UPDATE) inside one transaction, so two
 * concurrent holds can never overdraw. A charge is idempotent per (user, refKind, refId, category), and it never drives
 * available below zero: the excess is recorded as `shortfallMicro` in the entry detail (the operator absorbs it).
 */
export const MICRO = 1_000_000n;
export const CONTACT_EMAIL = "connect@kaushikh.xyz";
export const CREDITS_EXHAUSTED_MESSAGE =
  "You have used your credits. Write to connect@kaushikh.xyz to request more access.";
export const DEFAULT_ALLOWANCE_USD = "3";

export type UsdCategory = "model" | "outlayer" | "anchor";
export type UsdEntryKind = "grant" | "hold" | "charge" | "release";

/** "3.5" -> 3_500_000n. Digits beyond 6 places round UP (a charge is never understated). */
export function usdStringToMicro(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", `Not a USD amount: ${s}`);
  const frac = m[2] ?? "";
  const head = BigInt(m[1]!) * MICRO + BigInt(frac.slice(0, 6).padEnd(6, "0"));
  return /[1-9]/.test(frac.slice(6)) ? head + 1n : head;
}
/** A JS number of USD -> micro-USD, rounded up (non-finite or negative is refused). */
export function usdNumberToMicro(n: number): bigint {
  if (!Number.isFinite(n) || n < 0)
    throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", "Bad USD amount.");
  return usdStringToMicro(n.toFixed(9));
}
/** 3_000_000n -> "3.000000". */
export function microToUsd(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / MICRO}.${(a % MICRO).toString().padStart(6, "0")}`;
}

/** The per-account allowance: `NEARESIS_USER_CREDIT_USD` (default 3), as micro-USD. */
export function allowanceMicroFromEnv(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.NEARESIS_USER_CREDIT_USD?.trim();
  try {
    return usdStringToMicro(raw && raw.length > 0 ? raw : DEFAULT_ALLOWANCE_USD);
  } catch {
    return usdStringToMicro(DEFAULT_ALLOWANCE_USD);
  }
}

/** A decimal rate string ("3.456789") as an integer scaled by 1e18 (extra digits round up). */
export function rateScaled(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m) throw new KernelError("VALIDATION_FAILED", "INVALID_RATE", "Not a decimal rate.");
  const frac = m[2] ?? "";
  const head = BigInt(m[1]!) * 10n ** 18n + BigInt(frac.slice(0, 18).padEnd(18, "0"));
  return /[1-9]/.test(frac.slice(18)) ? head + 1n : head;
}
/** yoctoNEAR x (USD per NEAR) -> micro-USD, rounded up to a whole micro-USD. Exact bigint arithmetic. */
export function yoctoToMicroUsd(yocto: bigint, rate: string): bigint {
  if (yocto < 0n) throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", "Negative amount.");
  const den = 10n ** 36n; // 1e24 yocto per NEAR x 1e18 rate scale / 1e6 micro per USD
  const num = yocto * rateScaled(rate);
  return (num + den - 1n) / den;
}

export interface UsdAccount {
  grantedMicro: bigint;
  spentMicro: bigint;
  heldMicro: bigint;
  availableMicro: bigint;
}
export interface UsdEntry {
  id: string;
  kind: UsdEntryKind;
  category: UsdCategory | "grant";
  amountMicro: bigint;
  refKind: string | null;
  refId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}
export interface UsdRef {
  refKind: string;
  refId: string;
  category: UsdCategory;
  detail?: Record<string, unknown>;
}
export interface UsdSummary extends UsdAccount {
  byCategoryMicro: Record<UsdCategory, bigint>;
}

export interface ExhaustedFacts {
  allowanceMicro: bigint;
  spentMicro: bigint;
  availableMicro: bigint;
  requiredMicro: bigint | null;
}
/** The 402 body details of an exhausted account (also what an agent step carries when it is refused for credits). */
export function exhaustedDetails(f: ExhaustedFacts) {
  return {
    allowanceUsd: microToUsd(f.allowanceMicro),
    spentUsd: microToUsd(f.spentMicro),
    availableUsd: microToUsd(f.availableMicro < 0n ? 0n : f.availableMicro),
    requiredUsd: f.requiredMicro === null ? null : microToUsd(f.requiredMicro),
    contactEmail: CONTACT_EMAIL,
  };
}

/** Thrown when available credits are zero or below what an operation needs. Maps to 402 BUDGET_EXCEEDED / CREDITS_EXHAUSTED. */
export class CreditsExhausted extends KernelError {
  constructor(readonly facts: ExhaustedFacts) {
    super("BUDGET_EXCEEDED", "CREDITS_EXHAUSTED", CREDITS_EXHAUSTED_MESSAGE, {
      retryable: false,
      detailsObject: exhaustedDetails(facts),
    });
    this.name = "CreditsExhausted";
  }
}

const big = (v: unknown): bigint => BigInt(String(v));

interface Locked {
  granted: bigint;
  spent: bigint;
  held: bigint;
}

async function lockAccount(tx: Tx, userId: string, allowance: bigint): Promise<Locked> {
  const ins = await tx.query<{ user_id: string }>(
    `INSERT INTO usd_credit_accounts(user_id, granted_micro) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
    [userId, allowance.toString()],
  );
  if ((ins.rowCount ?? 0) > 0)
    await tx.query(
      `INSERT INTO usd_credit_entries(user_id, kind, category, amount_micro, ref_kind, ref_id, detail)
       VALUES ($1,'grant','grant',$2,'grant',$4,$3::jsonb)`,
      [userId, allowance.toString(), JSON.stringify({ reason: "allowance on first use" }), userId],
    );
  const r = await tx.query<{ granted_micro: string; spent_micro: string; held_micro: string }>(
    "SELECT granted_micro, spent_micro, held_micro FROM usd_credit_accounts WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  const row = r.rows[0];
  if (!row)
    throw new KernelError("INTERNAL", "CREDIT_ACCOUNT_MISSING", "Credit account could not be locked.");
  return { granted: big(row.granted_micro), spent: big(row.spent_micro), held: big(row.held_micro) };
}

async function write(tx: Tx, userId: string, spent: bigint, held: bigint): Promise<void> {
  await tx.query(
    "UPDATE usd_credit_accounts SET spent_micro = $2, held_micro = $3, updated_at = now() WHERE user_id = $1",
    [userId, spent.toString(), held.toString()],
  );
}

async function entry(
  tx: Tx,
  userId: string,
  kind: UsdEntryKind,
  amount: bigint,
  ref: UsdRef,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO usd_credit_entries(user_id, kind, category, amount_micro, ref_kind, ref_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
    [
      userId,
      kind,
      ref.category,
      amount.toString(),
      ref.refKind,
      ref.refId,
      JSON.stringify({ ...(ref.detail ?? {}), ...extra }),
    ],
  );
  return r.rows[0]!.id;
}

const facts = (a: Locked, required: bigint | null): ExhaustedFacts => ({
  allowanceMicro: a.granted,
  spentMicro: a.spent,
  availableMicro: a.granted - a.spent - a.held,
  requiredMicro: required,
});

/** Reads (and on first use grants) the account. */
export async function readUsdAccountIn(tx: Tx, userId: string, allowance: bigint): Promise<UsdAccount> {
  const a = await lockAccount(tx, userId, allowance);
  return {
    grantedMicro: a.granted,
    spentMicro: a.spent,
    heldMicro: a.held,
    availableMicro: a.granted - a.spent - a.held,
  };
}

/** Throws CreditsExhausted unless available > 0 and (when given) available >= required. */
export async function requireUsdAvailableIn(
  tx: Tx,
  userId: string,
  allowance: bigint,
  required?: bigint,
): Promise<UsdAccount> {
  const a = await readUsdAccountIn(tx, userId, allowance);
  if (a.availableMicro <= 0n || (required !== undefined && a.availableMicro < required))
    throw new CreditsExhausted({
      allowanceMicro: a.grantedMicro,
      spentMicro: a.spentMicro,
      availableMicro: a.availableMicro,
      requiredMicro: required ?? null,
    });
  return a;
}

/** Moves `amount` from available to held. Throws CreditsExhausted when available < amount. */
export async function holdUsdIn(
  tx: Tx,
  userId: string,
  allowance: bigint,
  amount: bigint,
  ref: UsdRef,
): Promise<string> {
  if (amount <= 0n)
    throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", "hold amount must be positive.");
  const a = await lockAccount(tx, userId, allowance);
  if (a.granted - a.spent - a.held < amount) throw new CreditsExhausted(facts(a, amount));
  await write(tx, userId, a.spent, a.held + amount);
  return entry(tx, userId, "hold", amount, ref);
}

export interface ChargeResult {
  chargedMicro: bigint;
  releasedMicro: bigint;
  shortfallMicro: bigint;
  /** True when this (user, ref, category) was charged before: nothing changed. */
  duplicate: boolean;
}

/**
 * Settles `actual` against an optional hold of `held` (0n = a direct charge with no hold): the hold is dropped, up to
 * `actual` is charged (never more than the hold plus what is available), the rest of the hold is released, and any excess
 * is recorded as `shortfallMicro`. Idempotent: a repeat for the same (user, refKind, refId, category) changes nothing.
 */
export async function chargeUsdIn(
  tx: Tx,
  userId: string,
  allowance: bigint,
  held: bigint,
  actual: bigint,
  ref: UsdRef,
): Promise<ChargeResult> {
  if (held < 0n || actual < 0n)
    throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", "Negative amount.");
  const a = await lockAccount(tx, userId, allowance);
  const prior = await tx.query<{ amount_micro: string }>(
    `SELECT amount_micro FROM usd_credit_entries
      WHERE user_id = $1 AND kind = 'charge' AND ref_kind = $2 AND ref_id = $3 AND category = $4`,
    [userId, ref.refKind, ref.refId, ref.category],
  );
  if (prior.rows[0]) {
    // Already charged: nothing is charged again, but a hold taken for this attempt is given back.
    if (held > 0n && a.held >= held) {
      await write(tx, userId, a.spent, a.held - held);
      await entry(tx, userId, "release", held, ref, { reason: "already charged" });
    }
    return {
      chargedMicro: big(prior.rows[0].amount_micro),
      releasedMicro: held,
      shortfallMicro: 0n,
      duplicate: true,
    };
  }
  if (a.held < held)
    throw new KernelError("INTERNAL", "HOLD_NOT_FOUND", "The account holds less than the amount to settle.");
  const cap = held + (a.granted - a.spent - a.held);
  const charged = actual < cap ? actual : cap;
  const released = held > charged ? held - charged : 0n;
  const shortfall = actual - charged;
  await write(tx, userId, a.spent + charged, a.held - held);
  await entry(
    tx,
    userId,
    "charge",
    charged,
    ref,
    shortfall > 0n ? { shortfallMicro: shortfall.toString(), shortfallUsd: microToUsd(shortfall) } : {},
  );
  if (released > 0n) await entry(tx, userId, "release", released, ref);
  return { chargedMicro: charged, releasedMicro: released, shortfallMicro: shortfall, duplicate: false };
}

/** Returns a whole hold to available credits. */
export async function releaseUsdIn(
  tx: Tx,
  userId: string,
  allowance: bigint,
  held: bigint,
  ref: UsdRef,
): Promise<void> {
  if (held <= 0n)
    throw new KernelError("VALIDATION_FAILED", "INVALID_AMOUNT", "release amount must be positive.");
  const a = await lockAccount(tx, userId, allowance);
  if (a.held < held)
    throw new KernelError("INTERNAL", "HOLD_NOT_FOUND", "The account holds less than the amount to release.");
  await write(tx, userId, a.spent, a.held - held);
  await entry(tx, userId, "release", held, ref);
}

export interface UsdCreditsOptions {
  /** Allowance granted on first use (default: NEARESIS_USER_CREDIT_USD, else USD 3). */
  allowanceMicro?: bigint;
}

export class UsdCreditsService {
  readonly allowanceMicro: bigint;
  constructor(
    private readonly db: Db,
    o: UsdCreditsOptions = {},
  ) {
    this.allowanceMicro = o.allowanceMicro ?? allowanceMicroFromEnv();
  }
  account(ctx: TenantContext): Promise<UsdAccount> {
    return this.db.tx(ctx, (tx) => readUsdAccountIn(tx, ctx.userId, this.allowanceMicro));
  }
  /** Account plus what was charged per category. */
  summary(ctx: TenantContext): Promise<UsdSummary> {
    return this.db.tx(ctx, async (tx) => {
      const a = await readUsdAccountIn(tx, ctx.userId, this.allowanceMicro);
      const r = await tx.query<{ category: UsdCategory; total: string }>(
        `SELECT category, SUM(amount_micro)::text AS total FROM usd_credit_entries
          WHERE user_id = $1 AND kind = 'charge' GROUP BY category`,
        [ctx.userId],
      );
      const by: Record<UsdCategory, bigint> = { model: 0n, outlayer: 0n, anchor: 0n };
      for (const x of r.rows) if (x.category in by) by[x.category] = big(x.total);
      return { ...a, byCategoryMicro: by };
    });
  }
  /** Gate: throws CreditsExhausted (402) when available is zero or below `required`. */
  require(ctx: TenantContext, required?: bigint): Promise<UsdAccount> {
    return this.db.tx(ctx, (tx) => requireUsdAvailableIn(tx, ctx.userId, this.allowanceMicro, required));
  }
  hold(ctx: TenantContext, amount: bigint, ref: UsdRef): Promise<string> {
    return this.db.tx(ctx, (tx) => holdUsdIn(tx, ctx.userId, this.allowanceMicro, amount, ref));
  }
  /** Settles a hold with the actual amount (see chargeUsdIn). */
  settle(ctx: TenantContext, held: bigint, actual: bigint, ref: UsdRef): Promise<ChargeResult> {
    return this.db.tx(ctx, (tx) => chargeUsdIn(tx, ctx.userId, this.allowanceMicro, held, actual, ref));
  }
  /** A direct charge without a hold (model spend that already happened). Idempotent per ref. */
  charge(ctx: TenantContext, actual: bigint, ref: UsdRef): Promise<ChargeResult> {
    return this.db.tx(ctx, (tx) => chargeUsdIn(tx, ctx.userId, this.allowanceMicro, 0n, actual, ref));
  }
  release(ctx: TenantContext, held: bigint, ref: UsdRef): Promise<void> {
    return this.db.tx(ctx, (tx) => releaseUsdIn(tx, ctx.userId, this.allowanceMicro, held, ref));
  }
  entries(ctx: TenantContext, limit = 100): Promise<UsdEntry[]> {
    return this.db.tx(ctx, async (tx) => {
      const r = await tx.query<{
        id: string;
        kind: UsdEntryKind;
        category: UsdCategory | "grant";
        amount_micro: string;
        ref_kind: string | null;
        ref_id: string | null;
        detail: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT id, kind, category, amount_micro, ref_kind, ref_id, detail, created_at
           FROM usd_credit_entries WHERE user_id = $1 ORDER BY seq DESC LIMIT $2`,
        [ctx.userId, limit],
      );
      return r.rows.map((x) => ({
        id: x.id,
        kind: x.kind,
        category: x.category,
        amountMicro: big(x.amount_micro),
        refKind: x.ref_kind,
        refId: x.ref_id,
        detail: x.detail,
        createdAt: x.created_at.toISOString(),
      }));
    });
  }

  /**
   * Charges every finished, uncharged run to the user who started it, once, with the USD the run's own budget ledger
   * recorded. Safe to call any time and from any process (idempotent per run); a database without the runtime schema
   * reports 0. `userId` limits the scan (before reading one user's credits); without it, every user (startup).
   */
  async reconcileRuns(userId?: string): Promise<{ charged: number }> {
    let rows: Array<{ run_id: string; tenant_id: string; requested_by: string; usd: string }>;
    try {
      rows = await this.db.txGlobal(async (tx) => {
        const r = await tx.query<{ run_id: string; tenant_id: string; requested_by: string; usd: string }>(
          "SELECT run_id, tenant_id, requested_by, usd FROM usd_credit_uncharged_runs($1::uuid)",
          [userId ?? null],
        );
        return r.rows;
      });
    } catch (e) {
      const c = (e as { code?: string } | null)?.code;
      if (c === "42P01" || c === "3F000" || c === "42501" || c === "42883") return { charged: 0 };
      throw e;
    }
    let charged = 0;
    for (const r of rows) {
      try {
        const res = await this.charge(
          { orgId: r.tenant_id, userId: r.requested_by },
          usdStringToMicro(r.usd),
          {
            refKind: "run",
            refId: r.run_id,
            category: "model",
            detail: { runId: r.run_id, source: "run_budget", usd: r.usd },
          },
        );
        if (!res.duplicate) charged++;
      } catch {
        // a run whose requester has no account row to create (for example a service principal) is skipped, never fatal
      }
    }
    return { charged };
  }
}
