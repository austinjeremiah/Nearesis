import { randomUUID } from "node:crypto";
import { WatermarkEvent as WatermarkEventSchema } from "@nearesis/contracts";
import type { Condition, TriggerMode, TriggerOutcome, WatermarkEvent } from "@nearesis/contracts";
import type { Db } from "../db/pool.ts";
import type { EventJournal } from "../journal.ts";
import { KernelError } from "../errors.ts";
import { zodDetails } from "../workspace.ts";
import { evaluateCondition } from "./condition.ts";

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
}

export interface SchedulerOptions {
  holder?: string;
  leaseMs?: number;
  batch?: number;
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
    this.onRuleSelected = opts.onRuleSelected;
  }

  /** Records a source-watermark update for the scheduler. Idempotent per (source, watermark, mode). */
  async enqueue(raw: WatermarkEvent): Promise<{ enqueued: boolean }> {
    const r = WatermarkEventSchema.safeParse(raw);
    if (!r.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_WATERMARK_EVENT", "Invalid watermark event.", {
        details: zodDetails(r.error),
      });
    const e = r.data;
    const res = await this.db.txGlobal((tx) =>
      tx.query(
        `INSERT INTO source_watermark_events(source_id, watermark, mode, values_json) VALUES ($1,$2,$3,$4)
         ON CONFLICT (source_id, watermark, mode) DO NOTHING RETURNING id`,
        [e.sourceId, e.watermark, e.mode, JSON.stringify(e.values)],
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
    return { held: true, cursor: Number(r.rows[0].cursor_id) };
  }

  async releaseLease(): Promise<void> {
    await this.db.txGlobal((tx) =>
      tx.query(
        "UPDATE monitor_scheduler_lease SET expires_at = now() - interval '1 second' WHERE name = $1 AND holder = $2",
        [SCHEDULER_LEASE_NAME, this.holder],
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
        }>(
          "SELECT id, source_id, watermark, mode, values_json FROM source_watermark_events WHERE id > $1 ORDER BY id LIMIT $2",
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

  /** Evaluates one event against every enabled rule listening to its source. Safe to call from competing workers. */
  async processEvent(raw: WatermarkEvent, scope: { workspaceId?: string } = {}): Promise<ProcessResult[]> {
    const ev = WatermarkEventSchema.parse(raw);
    const rules = (
      await this.db.txGlobal((tx) =>
        tx.query<{ rule_id: string; org_id: string; workspace_id: string; created_by: string }>(
          "SELECT rule_id, org_id, workspace_id, created_by FROM monitor_rules_for_source($1)",
          [ev.sourceId],
        ),
      )
    ).rows;
    const out: ProcessResult[] = [];
    for (const r of rules.filter((x) => !scope.workspaceId || x.workspace_id === scope.workspaceId))
      out.push(await this.processRule(r, ev));
    return out;
  }

  private async processRule(
    r: { rule_id: string; org_id: string; workspace_id: string; created_by: string },
    ev: WatermarkEvent,
  ): Promise<ProcessResult> {
    const wm = Date.parse(ev.watermark);
    await this.onRuleSelected?.(r.rule_id);
    return this.db.tx({ orgId: r.org_id, userId: r.created_by, actorKind: "service" }, async (tx) => {
      // Lock order matches the command bus: workspace, then rule. Disable/enable commands hold the same locks, so a rule
      // disabled before this point is seen as disabled here and never executes.
      const ws = (
        await tx.query<{ version: number }>("SELECT version FROM workspaces WHERE id = $1 FOR UPDATE", [
          r.workspace_id,
        ])
      ).rows[0];
      const rule = (
        await tx.query<{
          id: string;
          name: string;
          enabled: boolean;
          marker_id: string | null;
          action: "notify" | "investigate";
          condition_json: Condition;
          min_interval_seconds: number;
          debounce_seconds: number;
          cooldown_seconds: number;
          state_json: RuleState;
          created_by: string | null;
        }>("SELECT * FROM monitor_rules WHERE id = $1 FOR UPDATE", [r.rule_id])
      ).rows[0];
      if (!ws || !rule || !rule.enabled) return { ruleId: r.rule_id, outcome: "disabled" as const };

      const st: ModeState = { ...(rule.state_json[ev.mode] ?? {}) };
      const last = st.lastEvaluatedAt ? Date.parse(st.lastEvaluatedAt) : undefined;
      let outcome: TriggerOutcome;
      let fire = false;
      if (last !== undefined && (wm <= last || wm - last < rule.min_interval_seconds * 1000)) {
        outcome = "frequency"; // too soon (or out of order): not an evaluation, no state change
      } else {
        st.lastEvaluatedAt = ev.watermark;
        const c = evaluateCondition(rule.condition_json, ev.values);
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
      const result: ProcessResult = { ruleId: r.rule_id, outcome, triggerId };
      if (fire && notificationId) {
        const replay = ev.mode === "replay";
        await tx.query(
          `INSERT INTO notifications(id, org_id, workspace_id, rule_id, trigger_id, marker_id, mode, title, body)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
          ],
        );
        result.notificationId = notificationId;
        if (rule.action === "investigate" && rule.marker_id) {
          const taskId = randomUUID();
          const t = await tx.query(
            `INSERT INTO marker_tasks(id, org_id, workspace_id, marker_id, origin, mode, trigger_id, requested_by, agents)
             VALUES ($1,$2,$3,$4,'rule',$5,$6,$7,'[]'::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
            [taskId, r.org_id, r.workspace_id, rule.marker_id, ev.mode, triggerId, rule.created_by],
          );
          if (t.rows[0]) result.taskId = taskId;
        }
        await this.journal.append(tx, {
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
        await this.journal.append(tx, {
          orgId: r.org_id,
          workspaceId: r.workspace_id,
          type: "notification.created",
          actorId: null,
          data: { notificationId, ruleId: r.rule_id, mode: ev.mode },
          causationId: triggerId,
          sourceRevision: ws.version,
        });
      }
      return result;
    });
  }
}
