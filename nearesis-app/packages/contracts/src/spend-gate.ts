/**
 * Spend gate port (ch.13 cost model). Adapters that can spend money at a provider (BigQuery, OutLayer, paid HTTP,
 * object storage, workflow operations) take an optional `SpendGate` and call `gatedSpend` around the provider call:
 * the spend is authorised BEFORE the call (a refusal throws and the provider is never reached), then settled with the
 * actual quantity, or released when the call failed before incurring cost. The runtime implements the port with the
 * `CostGovernor` (`scopedSpendGate` in @nearesis/agent-runtime); this package stays dependency-free.
 */
export interface SpendGateRequest {
  /** Unique per attempt: a repeated key replays the first reservation instead of reserving again. */
  key: string;
  /** One of the nine cost dimensions (validated by the governor). */
  dimension: string;
  quantity: number;
  usd?: number;
  /** Operation that costs money at an external provider; must be permitted by the workspace policy. */
  paidOp?: string;
  detail?: Record<string, unknown>;
}

export interface SpendGate {
  authorize(r: SpendGateRequest): Promise<unknown>;
  settle(key: string, actual: { quantity: number; usd?: number }): Promise<unknown>;
  release(key: string): Promise<void>;
  /** Meters spend that already happened or must never be refused (control-plane work, response bytes). */
  observe(r: SpendGateRequest): Promise<void>;
}

/** True for the governor's CostBlockedError (matched by name so adapters need not import the runtime). */
export function isSpendBlocked(e: unknown): boolean {
  return e instanceof Error && e.name === "CostBlockedError";
}

let seq = 0;
/** A unique idempotency key for one attempt of one provider call. */
export function spendKey(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}:${Date.now().toString(36)}:${seq.toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Authorise -> run -> settle. Without a gate it just runs. A refused authorisation throws before `run` is called.
 * `run` reports the actual quantity; if it throws, the reservation is released unless the error carries `billed`
 * (a number: the provider charged before failing), in which case that quantity is settled.
 */
export async function gatedSpend<T>(
  gate: SpendGate | undefined,
  req: SpendGateRequest,
  run: () => Promise<{ result: T; quantity: number; usd?: number }>,
): Promise<T> {
  if (!gate) return (await run()).result;
  await gate.authorize(req);
  let out: { result: T; quantity: number; usd?: number };
  try {
    out = await run();
  } catch (e) {
    const billed = (e as { billedQuantity?: unknown } | null)?.billedQuantity;
    if (typeof billed === "number" && Number.isFinite(billed))
      await gate.settle(req.key, { quantity: billed });
    else await gate.release(req.key);
    throw e;
  }
  await gate.settle(req.key, { quantity: out.quantity, ...(out.usd !== undefined ? { usd: out.usd } : {}) });
  return out.result;
}
