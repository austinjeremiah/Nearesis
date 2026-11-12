import { randomUUID } from "node:crypto";
import { WatermarkEvent as WatermarkEventSchema } from "@nearesis/contracts";
import type {
  Condition,
  EvaluationStatus,
  TriggerMode,
  TriggerOutcome,
  WatermarkEvent,
  WatermarkEventInput,
} from "@nearesis/contracts";
import type { Db, Tx } from "../db/pool.ts";
import type { AppendArgs, EventJournal } from "../journal.ts";
import { appendBatch } from "./journal-batch.ts";
import { KernelError } from "../errors.ts";
import { zodDetails } from "../workspace.ts";
import { conditionHasHistory, evaluateCondition } from "./condition.ts";
import type { EvalContext, ZscoreStat } from "./condition.ts";

export const SCHEDULER_LEASE_NAME = "monitor";

interface ModeState {
  lastEvaluatedAt?: string;
  trueSince?: string | null;
  lastFiredAt?: string;
}
type RuleState = Partial<Record<TriggerMode, ModeState>>;

export interface ProcessResult {
  ruleId: string;
  /** `duplicate`: another worker already processed this (rule, watermark, mode). `disabled`: not executed at all. */
  outcome: TriggerOutcome | "duplicate";
  triggerId?: string;
  notificationId?: string;
  taskId?: string;
  /** The status recorded in `monitor_evaluations` (differs from `outcome` for `disabled`, `not_final` and run-cap suppression). */
  evaluationStatus?: EvaluationStatus;
}

export interface SchedulerOptions {
  holder?: string;
  leaseMs?: number;
  batch?: number;
  /** Maximum workspaces evaluated at once for one event (default 8). */
  concurrency?: number;
  /**
   * Test seam: awaited after a rule was selected as enabled and before it is locked and evaluated, to exercise the
   * select-then-disable race. Never set in production.
   */
  onRuleSelected?: (ruleId: string) => Promise<void>;
}

/**
 * Monitor scheduler (ch.09 refresh architecture, ch.15 P06). Only the lease holder consumes the watermark inbox, but
 * correctness never depends on the lease: `processEvent` is safe under any number of competing workers because the
 * `(rule, watermark, mode)` trigger row is unique in Postgres and the rule row is locked while it is evaluated.
 * Rule time is the source-watermark time, so replay and live share one deterministic clock per mode.
 */
export class MonitorScheduler {
  readonly holder: string;
  private readonly leaseMs: number;
  private readonly batch: number;
  private readonly concurrency: number;
  private readonly onRuleSelected: ((ruleId: string) => Promise<void>) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private fence = 0;

  constructor(
    private readonly db: Db,
    private readonly journal: EventJournal,
    opts: SchedulerOptions = {},
  ) {
    this.holder = opts.holder ?? `sched-${randomUUID()}`;
    this.leaseMs = opts.leaseMs ?? 15_000;
    this.batch = opts.batch ?? 100;
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.onRuleSelected = opts.onRuleSelected;
  }

  /** Records a source-watermark update for the scheduler. Idempotent per (source, watermark, mode). */
  async enqueue(raw: WatermarkEventInput): Promise<{ enqueued: boolean }> {
    const r = WatermarkEventSchema.safeParse(raw);
    if (!r.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_WATERMARK_EVENT", "Invalid watermark event.", {
        details: zodDetails(r.error),
      });
    const e = r.data;
    const res = await this.db.txGlobal((tx) =>
      tx.query(
        `INSERT INTO source_watermark_events(source_id, watermark, mode, values_json, maturity) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (source_id, watermark, mode) DO NOTHING RETURNING id`,
        [e.sourceId, e.watermark, e.mode, JSON.stringify(e.values), e.maturity],
      ),
    );
    return { enqueued: res.rows.length === 1 };
  }

  /** Acquire or renew the single-owner lease. Returns the fence token when held. */
  async acquireLease(): Promise<{ held: boolean; cursor: number }> {
    const r = await this.db.txGlobal((tx) =>
      tx.query<{ fence: string; cursor_id: string }>(
        `INSERT INTO monitor_scheduler_lease AS l(name, holder, fence, expires_at)
         VALUES ($1, $2, 1, now() + ($3 || ' milliseconds')::interval)
         ON CONFLICT (name) DO UPDATE SET holder = $2,
           fence = CASE WHEN l.holder = $2 THEN l.fence ELSE l.fence + 1 END,
           expires_at = now() + ($3 || ' milliseconds')::interval
         WHERE l.holder = $2 OR l.expires_at < now()
         RETURNING fence, cursor_id`,
        [SCHEDULER_LEASE_NAME, this.holder, String(this.leaseMs)],
      ),
    );
    if (!r.rows[0]) return { held: false, cursor: 0 };
    this.fence = Number(r.rows[0].fence);
    await this.db.txGlobal((tx) =>
      tx.query(
        `INSERT INTO monitor_scheduler_lease_history(name, fence, holder, acquired_at, expires_at)
         SELECT l.name, l.fence, l.holder, clock_timestamp(), l.expires_at FROM monitor_scheduler_lease l
          WHERE l.name = $1 AND l.holder = $2 AND l.fence = $3
         ON CONFLICT (name, fence) DO UPDATE SET expires_at = EXCLUDED.expires_at
           WHERE monitor_scheduler_lease_history.holder = EXCLUDED.holder`,
        [SCHEDULER_LEASE_NAME, this.holder, this.fence],
      ),
    );
    return { held: true, cursor: Number(r.rows[0].cursor_id) };
  }

  async releaseLease(): Promise<void> {
    await this.db.txGlobal((tx) =>
      tx.query(
        "UPDATE monitor_scheduler_lease SET expires_at = now() - interval '1 second' WHERE name = $1 AND holder = $2",
        [SCHEDULER_LEASE_NAME, this.holder],
      ),
    );
    await this.db.txGlobal((tx) =>
      tx.query(
        `UPDATE monitor_scheduler_lease_history SET released_at = clock_timestamp(), expires_at = LEAST(expires_at, clock_timestamp())
          WHERE name = $1 AND holder = $2 AND fence = $3`,
        [SCHEDULER_LEASE_NAME, this.holder, this.fence],
      ),
    );
  }

  /** One scheduling pass. A non-owner does nothing. */
  async tick(): Promise<{ owner: boolean; events: number; results: ProcessResult[] }> {
    const lease = await this.acquireLease();
    if (!lease.held) return { owner: false, events: 0, results: [] };
    const rows = (
      await this.db.txGlobal((tx) =>
        tx.query<{
          id: string;
          source_id: string;
          watermark: Date;
          mode: TriggerMode;
          values_json: Record<string, number>;
          maturity: "final" | "provisional";
        }>(
          "SELECT id, source_id, watermark, mode, values_json, maturity FROM source_watermark_events WHERE id > $1 ORDER BY id LIMIT $2",
          [lease.cursor, this.batch],
        ),
      )
    ).rows;
    const results: ProcessResult[] = [];
    for (const row of rows) {
      results.push(
        ...(await this.processEvent({
          sourceId: row.source_id,
          watermark: row.watermark.toISOString(),
          mode: row.mode,
          values: row.values_json,
          maturity: row.maturity,
        })),
      );
      const adv = await this.db.txGlobal((tx) =>
        tx.query(
          "UPDATE monitor_scheduler_lease SET cursor_id = $3 WHERE name = $1 AND holder = $2 AND fence = $4",
          [SCHEDULER_LEASE_NAME, this.holder, row.id, this.fence],
        ),
      );
      if (adv.rowCount === 0) break; // lost the lease mid-batch; the new owner resumes from the stored cursor
    }
    return { owner: true, events: rows.length, results };
  }

  start(intervalMs = 1000, onError: (e: unknown) => void = () => undefined): void {
    if (this.timer) return;
    const loop = (): void => {
      this.tick()
        .catch(onError)
        .finally(() => {
          if (this.timer) this.timer = setTimeout(loop, intervalMs);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.releaseLease().catch(() => undefined);
  }

  /** Evaluates one event against every rule listening to its source (disabled rules record `skipped_disabled`). Safe to call from competing workers. */
  async processEvent(
    raw: WatermarkEventInput,
    scope: { workspaceId?: string; ruleId?: string } = {},
  ): Promise<ProcessResult[]> {
    const ev = WatermarkEventSchema.parse(raw);
    const rules = (
      await this.db.txGlobal((tx) =>
        tx.query<RuleRef>(
          "SELECT rule_id, org_id, workspace_id, created_by FROM monitor_rules_for_source($1) ORDER BY rule_id",
          [ev.sourceId],
        ),
      )
    ).rows;
    // Rules of different workspaces are independent (each evaluation locks only its own workspace and rule), so they run
    // concurrently with a bound; rules of one workspace stay sequential in rule order. A 100-rule burst on one source then
    // costs about (rules per workspace) evaluations of latency instead of all 100 (PERF03).
    const todo = rules.filter(
      (x) =>
        (!scope.workspaceId || x.workspace_id === scope.workspaceId) &&
        (!scope.ruleId || x.rule_id === scope.ruleId),
    );
    const byWorkspace = new Map<string, Array<{ i: number; r: RuleRef }>>();
    todo.forEach((r, i) => {
      const g = byWorkspace.get(r.workspace_id) ?? [];
      g.push({ i, r });
      byWorkspace.set(r.workspace_id, g);
    });
    const out: ProcessResult[] = new Array<ProcessResult>(todo.length);
    const groups = [...byWorkspace.values()];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, groups.length) }, async () => {
        for (;;) {
          const g = groups[next++];
          if (!g) return;
          const res = await this.processWorkspace(
            g.map((x) => x.r),
            ev,
          );
          g.forEach((x, k) => (out[x.i] = res[k]!));
        }
      }),
    );
    return out;
  }

  /**
   * Evaluates one event for every listening rule of one workspace in one transaction: the workspace row is locked once
   * (not once per rule), rules, prior evaluations and duplicate checks are read with one statement each, and the journal
   * and outbox rows of all fired rules are written in one batch at the end (PERF03). Rules keep their order, so seq
   * numbers and results are identical to evaluating them one by one.
   */
  private async processWorkspace(rules: RuleRef[], ev: WatermarkEvent): Promise<ProcessResult[]> {
    const first = rules[0]!;
    // Test seam: after selection as enabled, before any lock is taken.
    for (const r of rules) await this.onRuleSelected?.(r.rule_id);
    return this.db.tx({ orgId: first.org_id, userId: first.created_by, actorKind: "service" }, async (tx) => {
      // Already evaluated for this (rule, watermark, mode)? Answer without taking any lock, so competing workers and
      // redeliveries do not queue behind fresh evaluations on the workspace row.
      const seen = new Set(
        (
          await tx.query<{ rule_id: string }>(
            "SELECT rule_id FROM monitor_triggers WHERE rule_id = ANY($1::uuid[]) AND watermark = $2 AND mode = $3",
            [rules.map((r) => r.rule_id), ev.watermark, ev.mode],
          )
        ).rows.map((x) => x.rule_id),
      );
      const fresh = rules.filter((r) => !seen.has(r.rule_id));
      const byRule = new Map<string, ProcessResult>();
      for (const r of rules)
        if (seen.has(r.rule_id)) byRule.set(r.rule_id, { ruleId: r.rule_id, outcome: "duplicate" });
      if (fresh.length > 0) {
        // Lock order matches the command bus: workspace, then rules. Disable/enable commands hold the same locks, so a
        // rule disabled before this point is seen as disabled here and never executes.
        const ws = (
          await tx.query<{ version: number }>("SELECT version FROM workspaces WHERE id = $1 FOR UPDATE", [
            first.workspace_id,
          ])
        ).rows[0];
        const ids = fresh.map((r) => r.rule_id);
        const ruleRows = new Map(
          (
            await tx.query<RuleRow>(
              "SELECT * FROM monitor_rules WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
              [ids],
            )
          ).rows.map((x) => [x.id, x]),
        );
        const priors = new Map(
          (
            await tx.query<{ rule_id: string; status: EvaluationStatus }>(
              `SELECT DISTINCT ON (rule_id) rule_id, status FROM monitor_evaluations
                WHERE rule_id = ANY($1::uuid[]) AND watermark = $2 AND mode = $3
                ORDER BY rule_id, evaluated_at DESC`,
              [ids, ev.watermark, ev.mode],
            )
          ).rows.map((x) => [x.rule_id, x.status]),
        );
        const pending: AppendArgs[] = [];
        for (const r of fresh) {
          const rule = ruleRows.get(r.rule_id);
          byRule.set(
            r.rule_id,
            !ws || !rule
              ? { ruleId: r.rule_id, outcome: "disabled" }
              : await this.evaluateRule(tx, r, ev, ws, rule, priors.get(r.rule_id), pending),
          );
        }
        await appendBatch(tx, pending);
      }
      return rules.map((r) => byRule.get(r.rule_id)!);
    });
  }

  private async evaluateRule(
    tx: Tx,
    r: RuleRef,
    ev: WatermarkEvent,
    ws: { version: number },
    rule: RuleRow,
    priorStatus: EvaluationStatus | undefined,
    pending: AppendArgs[],
  ): Promise<ProcessResult> {
    const wm = Date.parse(ev.watermark);
    {
      const recordEval = async (
        status: EvaluationStatus,
        evaluatedValue: Record<string, unknown>,
        triggerId: string | null,
        taskId: string | null,
      ): Promise<void> => {
        // A provisional watermark that is later delivered final is promoted in place, never duplicated.
        await tx.query(
          `INSERT INTO monitor_evaluations(id, org_id, workspace_id, rule_id, rule_version, semantic_version, source_id,
             watermark, mode, status, evaluated_value, trigger_id, task_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (rule_id, watermark, rule_version, mode) DO UPDATE
             SET status = EXCLUDED.status, evaluated_value = EXCLUDED.evaluated_value,
                 trigger_id = EXCLUDED.trigger_id, task_id = EXCLUDED.task_id, evaluated_at = now()
             WHERE monitor_evaluations.status = 'not_final'`,
          [
            randomUUID(),
            r.org_id,
            r.workspace_id,
            r.rule_id,
            rule.version,
            rule.semantic_version,
            ev.sourceId,
            ev.watermark,
            ev.mode,
            status,
            JSON.stringify(evaluatedValue),
            triggerId,
            taskId,
          ],
        );
      };
      const prior = priorStatus === undefined ? undefined : { status: priorStatus };

      if (!rule.enabled) {
        // Disabled: record the event as skipped (rule version in force + watermark). No state change, no task, no spend.
        await recordEval("skipped_disabled", { values: ev.values }, null, null);
        return {
          ruleId: r.rule_id,
          outcome: "disabled" as const,
          evaluationStatus: "skipped_disabled" as const,
        };
      }
      // Never backfill: a watermark skipped while the rule was disabled stays skipped when it is redelivered after re-enable.
      if (prior && prior.status === "skipped_disabled")
        return { ruleId: r.rule_id, outcome: "duplicate" as const };
      if (prior && prior.status !== "not_final") return { ruleId: r.rule_id, outcome: "duplicate" as const };

      if (ev.maturity === "provisional" && rule.data_maturity === "finalized_only") {
        if (!prior) await recordEval("not_final", { values: ev.values }, null, null);
        return {
          ruleId: r.rule_id,
          outcome: "condition_false" as const,
          evaluationStatus: "not_final" as const,
        };
      }

      const st: ModeState = { ...(rule.state_json[ev.mode] ?? {}) };
      const last = st.lastEvaluatedAt ? Date.parse(st.lastEvaluatedAt) : undefined;
      const stats: Record<string, ZscoreStat> = {};
      let outcome: TriggerOutcome;
      let fire = false;
      if (
        last !== undefined &&
        rule.min_interval_seconds > 0 &&
        (wm <= last || wm - last < rule.min_interval_seconds * 1000)
      ) {
        outcome = "frequency"; // too soon (or out of order): not an evaluation, no state change
      } else {
        if (last === undefined || wm > last) st.lastEvaluatedAt = ev.watermark;
        const ctx = conditionHasHistory(rule.condition_json)
          ? await this.zscoreContext(tx, rule, ev, stats)
          : { stats };
        const c = evaluateCondition(rule.condition_json, ev.values, ctx);
        if (c === null) {
          outcome = "no_data";
          st.trueSince = null;
        } else if (!c) {
          outcome = "condition_false";
          st.trueSince = null;
        } else {
          st.trueSince ??= ev.watermark;
          if (rule.debounce_seconds > 0 && wm - Date.parse(st.trueSince) < rule.debounce_seconds * 1000) {
            outcome = "debounced";
          } else if (
            rule.cooldown_seconds > 0 &&
            st.lastFiredAt !== undefined &&
            wm - Date.parse(st.lastFiredAt) < rule.cooldown_seconds * 1000
          ) {
            outcome = "cooldown";
          } else {
            outcome = "fired";
            fire = true;
            st.lastFiredAt = ev.watermark;
          }
        }
      }

      const triggerId = randomUUID();
      const notificationId = fire ? randomUUID() : null;
      const ins = await tx.query(
        `INSERT INTO monitor_triggers(id, org_id, workspace_id, rule_id, source_id, watermark, mode, outcome, observed, notification_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (rule_id, watermark, mode) DO NOTHING RETURNING id`,
        [
          triggerId,
          r.org_id,
          r.workspace_id,
          r.rule_id,
          ev.sourceId,
          ev.watermark,
          ev.mode,
          outcome,
          JSON.stringify(ev.values),
          notificationId,
        ],
      );
      if (ins.rows.length === 0) return { ruleId: r.rule_id, outcome: "duplicate" as const };

      await tx.query("UPDATE monitor_rules SET state_json = $2 WHERE id = $1", [
        r.rule_id,
        JSON.stringify({ ...rule.state_json, [ev.mode]: st }),
      ]);
      const result: ProcessResult = { ruleId: r.rule_id, outcome, triggerId, evaluationStatus: outcome };
      if (fire && notificationId) {
        const replay = ev.mode === "replay";
        await tx.query(
          `INSERT INTO notifications(id, org_id, workspace_id, rule_id, trigger_id, marker_id, mode, title, body, external_eligible)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            notificationId,
            r.org_id,
            r.workspace_id,
            r.rule_id,
            triggerId,
            rule.marker_id,
            ev.mode,
            `${replay ? "[REPLAY] " : ""}Monitor "${rule.name}" fired`,
            `${replay ? "Recorded replay event, not live data. " : ""}Source ${ev.sourceId} at watermark ${ev.watermark}.`.slice(
              0,
              2000,
            ),
            !replay,
          ],
        );
        result.notificationId = notificationId;
        if (rule.action === "investigate" && rule.marker_id) {
          if (
            rule.max_runs_per_day !== null &&
            (await this.runsToday(tx, rule, ev)) >= rule.max_runs_per_day
          ) {
            result.evaluationStatus = "suppressed_run_cap";
          } else {
            const taskId = randomUUID();
            const t = await tx.query(
              `INSERT INTO marker_tasks(id, org_id, workspace_id, marker_id, origin, mode, trigger_id, requested_by, agents)
               VALUES ($1,$2,$3,$4,'rule',$5,$6,$7,'[]'::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
              [taskId, r.org_id, r.workspace_id, rule.marker_id, ev.mode, triggerId, rule.created_by],
            );
            if (t.rows[0]) {
              result.taskId = taskId;
              // One link event per task: the marker keeps its status; the task has its own lifecycle.
              pending.push({
                orgId: r.org_id,
                workspaceId: r.workspace_id,
                type: "marker.assigned",
                actorId: null,
                data: { markerId: rule.marker_id, taskId, triggerId, origin: "rule", mode: ev.mode },
                causationId: triggerId,
                sourceRevision: ws.version,
              });
            }
          }
        }
        pending.push({
          orgId: r.org_id,
          workspaceId: r.workspace_id,
          type: "monitor.triggered",
          actorId: null,
          data: {
            ruleId: r.rule_id,
            triggerId,
            mode: ev.mode,
            watermark: ev.watermark,
            sourceId: ev.sourceId,
          },
          causationId: triggerId,
          sourceRevision: ws.version,
        });
        pending.push({
          orgId: r.org_id,
          workspaceId: r.workspace_id,
          type: "notification.created",
          actorId: null,
          data: { notificationId, ruleId: r.rule_id, mode: ev.mode },
          causationId: triggerId,
          sourceRevision: ws.version,
        });
      }
      await recordEval(
        result.evaluationStatus!,
        { values: ev.values, ...(Object.keys(stats).length ? { stats } : {}) },
        triggerId,
        result.taskId ?? null,
      );
      return result;
    }
  }

  /** Finalized observations of the same rule and mode inside the window before the watermark (oldest first). */
  private async zscoreContext(
    tx: Tx,
    rule: RuleRow,
    ev: WatermarkEvent,
    stats: Record<string, ZscoreStat>,
  ): Promise<EvalContext> {
    const rows = (
      await tx.query<{ watermark: Date; evaluated_value: { values?: Record<string, number> } }>(
        `SELECT watermark, evaluated_value FROM monitor_evaluations
          WHERE rule_id = $1 AND mode = $2 AND watermark < $3
            AND status NOT IN ('skipped_disabled','not_final')
          ORDER BY watermark`,
        [rule.id, ev.mode, ev.watermark],
      )
    ).rows;
    const wm = Date.parse(ev.watermark);
    return {
      stats,
      history: (metricId, windowDays) =>
        rows
          .filter((x) => wm - x.watermark.getTime() <= windowDays * 86_400_000)
          .map((x) => x.evaluated_value.values?.[metricId])
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    };
  }

  /** Agent tasks the rule already enqueued for this watermark's UTC day (the run cap is per day and per mode). */
  private async runsToday(tx: Tx, rule: RuleRow, ev: WatermarkEvent): Promise<number> {
    const day = ev.watermark.slice(0, 10);
    const r = await tx.query<{ n: string }>(
      `SELECT count(*)::text n FROM marker_tasks t JOIN monitor_triggers tr ON tr.id = t.trigger_id
        WHERE tr.rule_id = $1 AND tr.mode = $2 AND tr.watermark >= $3::date AND tr.watermark < ($3::date + 1)`,
      [rule.id, ev.mode, day],
    );
    return Number(r.rows[0]!.n);
  }
}

interface RuleRef {
  rule_id: string;
  org_id: string;
  workspace_id: string;
  created_by: string;
}
interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  marker_id: string | null;
  action: "notify" | "investigate";
  condition_json: Condition;
  min_interval_seconds: number;
  debounce_seconds: number;
  cooldown_seconds: number;
  state_json: RuleState;
  created_by: string | null;
  semantic_version: string | null;
  data_maturity: "finalized_only" | "any";
  max_runs_per_day: number | null;
}
