import { randomUUID } from "node:crypto";
import type { AnalyticsCapabilityId } from "@nearesis/contracts";
import {
  ClickHouseAccountSource,
  ClickHouseEntitySource,
  IntentsAnalytics,
  LIVE_DATABASE,
  createCh,
  createPg,
  notLiveSource,
  runAnalytics,
  saveQuery,
  type AnalyticsDeps,
} from "@nearesis/analytics";
import type { InvocationContext } from "@nearesis/plugin-sdk";

/**
 * Handlers of intents.analyze@1, entities.analyze@1 and accounts.analyze@1. The principal's tenant and workspace come
 * from the kernel context and are never read from the input; the analytics tables hold public warehouse data (no tenant rows).
 * Only runs submitted with the LIVE source reach the warehouse: a fixture run gets a typed CANNOT_COMPUTE, never real numbers
 * labelled as synthetic or the reverse.
 */
let deps: AnalyticsDeps | null = null;
let pg: ReturnType<typeof createPg> | null = null;
const wire = (): AnalyticsDeps => {
  if (deps) return deps;
  const ch = createCh({ database: LIVE_DATABASE });
  return (deps = {
    intents: new IntentsAnalytics(ch, { database: LIVE_DATABASE }),
    entities: new ClickHouseEntitySource(ch),
    accounts: new ClickHouseAccountSource(ch),
  });
};

/**
 * The intents queries scan the swap table (FINAL) and each holds hundreds of MB in ClickHouse, which also serves the backfill.
 * Concurrent calls (the composer issues its panels in parallel) are admitted two at a time per process, and a transient
 * "source unavailable" (typically MEMORY_LIMIT_EXCEEDED under load) is retried once after a short pause.
 */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];
async function admitted<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function analyticsHandler(
  capability: AnalyticsCapabilityId,
  isLive: (ctx: InvocationContext) => boolean,
) {
  return async (input: unknown, ctx: InvocationContext): Promise<unknown> => {
    if (!isLive(ctx)) return { ok: true, ...notLiveSource(capability, input) };
    const r = await admitted(async () => {
      const first = await runAnalytics(wire(), capability, input);
      if (first.ok || first.status !== 503) return first;
      await new Promise((res) => setTimeout(res, 1500));
      return runAnalytics(wire(), capability, input);
    });
    if (!r.ok)
      return {
        ok: false,
        status: r.status,
        error: {
          traceId: ctx.requestId || randomUUID(),
          errorCode:
            r.status === 404 ? "NOT_FOUND" : r.status === 503 ? "UPSTREAM_DEGRADED" : "VALIDATION_FAILED",
          reasonCode: r.code,
          message: r.message,
          retryable: r.status === 503,
        },
      };
    if (r.outcome.outcome === "OK") {
      // Content-addressed, insert-only: lets a panel that cites this hash re-execute the exact call later.
      try {
        pg ??= createPg();
        await saveQuery(pg, {
          queryHash: r.outcome.callHash,
          ast: { kind: "analytics_call", ...r.outcome.call },
          semanticVersion: "1.0.0",
          semanticModelHash: r.outcome.callHash,
        });
      } catch {
        /* the result is still returned; a panel citing it will report QUERY_UNKNOWN until the call is stored */
      }
    }
    return { ok: true, ...r.outcome };
  };
}

let winCache: { at: number; v: Record<string, { from: string; to: string } | null> } | null = null;
/** Observed UTC-day windows of the analytics warehouse for the composer's prompt (cached 5 minutes; null = nothing loaded). */
export async function analyticsWindows(): Promise<Record<string, { from: string; to: string } | null>> {
  if (winCache && Date.now() - winCache.at < 300_000) return winCache.v;
  const d = wire();
  const safe = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const [swaps, acc, latest] = await Promise.all([
    safe(() => d.intents.defaultWindow(366)),
    safe(() => d.accounts!.window()),
    safe(() => d.entities.latestDate()),
  ]);
  const v = {
    // first day is the first complete day within the last 366; the Explorer feed may start earlier, coverage says which days are complete
    intents: swaps ? { from: swaps.from, to: swaps.to } : null,
    accounts: acc ? { from: acc.from, to: acc.to } : null,
    entities: latest ? { from: latest, to: latest } : null,
  };
  winCache = { at: Date.now(), v };
  return v;
}
