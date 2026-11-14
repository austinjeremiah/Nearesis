import type pg from "pg";
import { emitAlert } from "../cost/alerts.ts";
import type { AlertSink, Querier } from "../cost/types.ts";
import { BURN_RULES, SLOS, sloById } from "./catalog.ts";
import type { BurnRule, SloDefinition } from "./catalog.ts";

export interface WindowStat {
  windowMs: number;
  good: number;
  total: number;
  errorRatio: number | null;
  burnRate: number | null;
}
export interface RuleResult {
  rule: BurnRule;
  long: WindowStat;
  short: WindowStat;
  firing: boolean;
}
export interface SloStatus {
  slo: SloDefinition;
  asOf: string;
  rules: RuleResult[];
  firing: RuleResult[];
  /** Fraction of the period's error budget consumed so far (over the data present), null without events. */
  budgetConsumed: number | null;
}

/** Pure: burn rate = observed error ratio / allowed error ratio (1 - objective). No events => no data, never a fire. */
export function windowStat(good: number, total: number, objective: number, windowMs: number): WindowStat {
  if (total <= 0) return { windowMs, good, total, errorRatio: null, burnRate: null };
  const errorRatio = 1 - good / total;
  return { windowMs, good, total, errorRatio, burnRate: errorRatio / (1 - objective) };
}

/** Pure: a rule fires only when BOTH its long and short window burn faster than the factor and have `minEvents`. */
export function evaluateRule(
  slo: SloDefinition,
  rule: BurnRule,
  stats: { long: { good: number; total: number }; short: { good: number; total: number } },
  minEvents = 10,
): RuleResult {
  const long = windowStat(stats.long.good, stats.long.total, slo.objective, rule.longMs);
  const short = windowStat(stats.short.good, stats.short.total, slo.objective, rule.shortMs);
  const firing =
    long.total >= minEvents &&
    short.total >= 1 &&
    long.burnRate !== null &&
    short.burnRate !== null &&
    long.burnRate >= rule.factor &&
    short.burnRate >= rule.factor;
  return { rule, long, short, firing };
}

async function sums(q: Querier, sloId: string, now: Date, windowMs: number) {
  const r = await q.query(
    `SELECT COALESCE(SUM(good),0)::float8 AS good, COALESCE(SUM(total),0)::float8 AS total
       FROM runtime.slo_buckets WHERE slo_id=$1 AND bucket_start > $2 AND bucket_start <= $3`,
    [sloId, new Date(now.getTime() - windowMs - 60_000).toISOString(), now.toISOString()],
  );
  return { good: r.rows[0].good as number, total: r.rows[0].total as number };
}

export async function sloStatus(
  q: Querier,
  slo: SloDefinition,
  now: Date,
  rules: BurnRule[] = BURN_RULES,
  minEvents = 10,
): Promise<SloStatus> {
  const out: RuleResult[] = [];
  for (const rule of rules)
    out.push(
      evaluateRule(
        slo,
        rule,
        { long: await sums(q, slo.id, now, rule.longMs), short: await sums(q, slo.id, now, rule.shortMs) },
        minEvents,
      ),
    );
  const period = await sums(q, slo.id, now, slo.periodDays * 86_400_000);
  return {
    slo,
    asOf: now.toISOString(),
    rules: out,
    firing: out.filter((r) => r.firing),
    budgetConsumed: period.total > 0 ? (1 - period.good / period.total) / (1 - slo.objective) : null,
  };
}

/** Buffers good/total counts per SLO and minute and upserts them. `record` never throws into the request path. */
export class SloRecorder {
  private buf = new Map<string, { slo: string; at: number; good: number; total: number }>();
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  record(sloId: string, good: boolean | number, total = 1, at?: Date): void {
    sloById(sloId);
    const minute = Math.floor((at ?? this.clock()).getTime() / 60_000) * 60_000;
    const k = `${sloId}:${minute}`;
    const e = this.buf.get(k) ?? { slo: sloId, at: minute, good: 0, total: 0 };
    e.good += typeof good === "boolean" ? (good ? 1 : 0) : good;
    e.total += total;
    this.buf.set(k, e);
  }
  start(everyMs = 5000): void {
    this.timer ??= setInterval(() => void this.flush().catch(() => undefined), everyMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush().catch(() => undefined);
  }
  async flush(): Promise<number> {
    const items = [...this.buf.values()];
    this.buf = new Map();
    for (const [i, e] of items.entries()) {
      try {
        await this.upsert(e);
      } catch (err) {
        // The database is unavailable: keep every unflushed count (this one included) for the next flush.
        for (const r of items.slice(i)) {
          const k = `${r.slo}:${r.at}`;
          const cur = this.buf.get(k);
          this.buf.set(k, cur ? { ...cur, good: cur.good + r.good, total: cur.total + r.total } : r);
        }
        throw err;
      }
    }
    return items.length;
  }

  private async upsert(e: { slo: string; at: number; good: number; total: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime.slo_buckets (slo_id, bucket_start, good, total) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slo_id, bucket_start) DO UPDATE SET good = runtime.slo_buckets.good + EXCLUDED.good, total = runtime.slo_buckets.total + EXCLUDED.total`,
      [e.slo, new Date(e.at).toISOString(), e.good, e.total],
    );
  }
}

export interface SloAlertCaps {
  maxPerWindow: number;
  windowSeconds: number;
  cooldownSeconds: number;
}
export const DEFAULT_SLO_ALERT_CAPS: SloAlertCaps = {
  maxPerWindow: 6,
  windowSeconds: 3600,
  cooldownSeconds: 300,
};

/**
 * Evaluates every declared SLO and emits one `slo.burn` alert per firing rule through the alert sink (kernel event path).
 * De-duplicated and cooled down exactly like every other operational alert (decideAlert).
 */
export async function evaluateAndAlert(
  pool: pg.Pool,
  sink: AlertSink | undefined,
  now: Date,
  o: { caps?: SloAlertCaps; slos?: SloDefinition[]; rules?: BurnRule[]; minEvents?: number } = {},
): Promise<{ statuses: SloStatus[]; sent: number; suppressed: number }> {
  const statuses: SloStatus[] = [];
  let sent = 0,
    suppressed = 0;
  for (const slo of o.slos ?? SLOS) {
    const st = await sloStatus(pool, slo, now, o.rules, o.minEvents);
    statuses.push(st);
    for (const f of st.firing) {
      const r = await emitAlert(
        pool,
        sink,
        {
          tenantId: null,
          workspaceId: null,
          key: `slo:${slo.id}:${f.rule.severity}:${f.rule.longMs}`,
          kind: "slo.burn",
          severity: f.rule.severity === "page" ? "critical" : "warning",
          title: `SLO ${slo.id} burning ${f.long.burnRate!.toFixed(1)}x the allowed error budget`,
          detail: {
            slo: slo.id,
            objective: slo.objective,
            rule: f.rule,
            longBurnRate: f.long.burnRate,
            shortBurnRate: f.short.burnRate,
            longEvents: f.long.total,
          },
        },
        o.caps ?? DEFAULT_SLO_ALERT_CAPS,
        now,
      );
      if (r.status === "sent") sent++;
      else suppressed++;
    }
  }
  return { statuses, sent, suppressed };
}
