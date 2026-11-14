import { IngestionError } from "../errors.ts";

export const MIB = 1024 * 1024;
/**
 * ADR-20261110-005: 95% of the 100 GiB/day project quota. NEARESIS_BQ_DAILY_LIMIT_MIB overrides it for a run when the
 * owner has raised the project's quota (owner approval 2026-11-14: 500 GiB/day for the fee pull, then back to 100 GiB).
 */
const LIMIT_OVERRIDE_MIB = Number(process.env.NEARESIS_BQ_DAILY_LIMIT_MIB ?? "");
export const DAILY_LIMIT_BYTES =
  Number.isInteger(LIMIT_OVERRIDE_MIB) && LIMIT_OVERRIDE_MIB > 0 ? LIMIT_OVERRIDE_MIB * MIB : 97_280 * MIB;

export type Fit = { ok: true; maximumBytesBilled: number } | { ok: false; reason: string; remaining: number };

/**
 * Tracks bytes billed since the quota-day start. `alreadyBilled` comes from INFORMATION_SCHEMA (all jobs of the project).
 * A chunk is only allowed when estimate x 1.02 fits what is left; the job then carries maximumBytesBilled = ceil(estimate x 1.1).
 */
export class BudgetLedger {
  private billed: number;
  readonly entries: Array<{ id: string; estimate: number; billed: number }> = [];
  constructor(
    alreadyBilled: number,
    readonly limit: number = DAILY_LIMIT_BYTES,
  ) {
    if (!Number.isFinite(alreadyBilled) || alreadyBilled < 0)
      throw new IngestionError("INVALID_INPUT", false, {
        reason: "alreadyBilled must be a finite, non-negative number",
      });
    this.billed = alreadyBilled;
  }
  get billedToday(): number {
    return this.billed;
  }
  get remaining(): number {
    return Math.max(0, this.limit - this.billed);
  }
  check(estimate: number): Fit {
    if (!Number.isFinite(estimate) || estimate < 0)
      return { ok: false, reason: "no valid dry-run estimate", remaining: this.remaining };
    if ((estimate * 102) / 100 > this.remaining)
      return {
        ok: false,
        reason: "estimate (with 2% margin) exceeds remaining daily budget",
        remaining: this.remaining,
      };
    return { ok: true, maximumBytesBilled: Math.ceil((estimate * 11) / 10) };
  }
  /** Records the actual bytes billed by a job (never less than 0). */
  record(id: string, estimate: number, billed: number): void {
    if (!Number.isFinite(billed) || billed < 0)
      throw new IngestionError("INVALID_INPUT", false, {
        reason: "billed bytes must be finite and non-negative",
      });
    this.billed += billed;
    this.entries.push({ id, estimate, billed });
  }
  /** Re-bases on a fresh INFORMATION_SCHEMA reading (never lowers below what this run knows it billed). */
  rebase(reading: number): void {
    this.billed = Math.max(reading, this.billed);
  }
}
