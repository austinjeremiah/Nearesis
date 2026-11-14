import type { SubmissionPriority } from "@nearesis/contracts";
import { OverloadError } from "./errors.ts";

/** `high` is server-originated work (monitor and marker tasks); callers of the public API can only ask for normal or low. */
export type Priority = SubmissionPriority | "high";
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export interface Occupancy {
  /** Run ids of this tenant that the runtime has recorded as not yet finished. */
  activeIds: string[];
  /** Of the ids asked about, those the runtime has recorded as finished. */
  terminalIds: string[];
}

export interface AdmissionOptions {
  /** Hard cap on concurrently running investigations per tenant. Default 6. */
  maxRunningPerTenant?: number;
  /** Submissions one tenant may have waiting for a slot. Default 16. */
  maxQueuedPerTenant?: number;
  /** Submissions waiting across all tenants. Default 128: the in-process bound on the queue. */
  maxQueuedGlobal?: number;
  /** A queued submission that has not been admitted by then is refused with 429. Default 5000. */
  queueTimeoutMs?: number;
  /** How often waiting tenants re-check occupancy. Default 100. */
  pollMs?: number;
  /** A started run the runtime never recorded is forgotten after this long (the workflow never started). Default 60000. */
  heldTtlMs?: number;
  /** Reads the runtime's occupancy. `heldIds` are the runs this process admitted and has not seen finish. */
  occupancy(tenantId: string, heldIds: string[]): Promise<Occupancy>;
  now?: () => number;
}

interface Waiter {
  priority: Priority;
  seq: number;
  enqueuedAt: number;
  grant: (t: Ticket) => void;
  fail: (e: Error) => void;
  timer: NodeJS.Timeout;
}
interface Held {
  runId: string | null;
  at: number;
}
interface TenantState {
  waiters: Waiter[];
  held: Map<string, Held>; // key: runId, or a reservation id until the run id is bound
  lock: Promise<void>;
  pumping: boolean;
  timer: NodeJS.Timeout | null;
  peakRunning: number;
  lastRunning: number;
}

/** A granted slot. Exactly one of `commit` (the run started) or `release` (it did not) must be called. */
export interface Ticket {
  tenantId: string;
  commit(runId: string): void;
  release(): void;
}

export interface AdmissionStats {
  queuedGlobal: number;
  peakQueuedGlobal: number;
  admitted: number;
  rejected: Record<string, number>;
  tenants: Record<string, { running: number; queued: number; peakRunning: number }>;
}

/**
 * Per-tenant concurrent investigation cap with a bounded, prioritised, timed wait queue (ch.13 Backpressure).
 *
 * Occupancy = runs the runtime shows as unfinished + runs admitted here that the runtime has not recorded yet, so a burst
 * cannot overshoot the cap in the window before the workflow writes its row. Admission for one tenant is serialised, so
 * 200 simultaneous submissions still admit at most `maxRunningPerTenant`. Tenants never share a queue or a lock: one
 * tenant's backlog adds no wait to another tenant's admission.
 */
export class TenantAdmission {
  readonly maxRunning: number;
  readonly maxQueued: number;
  readonly maxQueuedGlobal: number;
  readonly queueTimeoutMs: number;
  private readonly pollMs: number;
  private readonly heldTtlMs: number;
  private readonly now: () => number;
  private readonly tenants = new Map<string, TenantState>();
  private seq = 0;
  private queuedGlobal = 0;
  private peakQueuedGlobal = 0;
  private admitted = 0;
  private readonly rejected: Record<string, number> = {};

  constructor(private readonly o: AdmissionOptions) {
    this.maxRunning = Math.max(1, o.maxRunningPerTenant ?? 6);
    this.maxQueued = Math.max(0, o.maxQueuedPerTenant ?? 16);
    this.maxQueuedGlobal = Math.max(0, o.maxQueuedGlobal ?? 128);
    this.queueTimeoutMs = Math.max(1, o.queueTimeoutMs ?? 5000);
    this.pollMs = Math.max(5, o.pollMs ?? 100);
    this.heldTtlMs = o.heldTtlMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  private st(tenantId: string): TenantState {
    let s = this.tenants.get(tenantId);
    if (!s) {
      if (this.tenants.size >= 1000)
        for (const [id, x] of this.tenants)
          if (x.waiters.length === 0 && x.held.size === 0 && !x.pumping) this.tenants.delete(id);
      s = {
        waiters: [],
        held: new Map(),
        lock: Promise.resolve(),
        pumping: false,
        timer: null,
        peakRunning: 0,
        lastRunning: 0,
      };
      this.tenants.set(tenantId, s);
    }
    return s;
  }

  private count(kind: string): void {
    this.rejected[kind] = (this.rejected[kind] ?? 0) + 1;
  }
  private retryAfter(): number {
    return Math.max(1, Math.ceil(this.queueTimeoutMs / 1000));
  }

  /** Serialises `fn` per tenant. */
  private async locked<T>(s: TenantState, fn: () => Promise<T>): Promise<T> {
    const prev = s.lock;
    let done!: () => void;
    s.lock = new Promise<void>((r) => (done = r));
    await prev;
    try {
      return await fn();
    } finally {
      done();
    }
  }

  /** Current occupancy of a tenant: the number that is compared with the cap. Call under the tenant lock. */
  private async running(tenantId: string, s: TenantState): Promise<number> {
    const t = this.now();
    for (const [k, h] of s.held) if (t - h.at > this.heldTtlMs) s.held.delete(k);
    const ids = [...s.held.values()].map((h) => h.runId).filter((x): x is string => x !== null);
    const occ = await this.o.occupancy(tenantId, ids);
    const terminal = new Set(occ.terminalIds);
    for (const [k, h] of s.held) if (h.runId !== null && terminal.has(h.runId)) s.held.delete(k);
    const active = new Set(occ.activeIds);
    let unseen = 0;
    for (const h of s.held.values()) if (h.runId === null || !active.has(h.runId)) unseen++;
    s.lastRunning = active.size + unseen;
    return s.lastRunning;
  }

  private ticket(tenantId: string, s: TenantState, key: string): Ticket {
    let used = false;
    return {
      tenantId,
      commit: (runId) => {
        if (used) return;
        used = true;
        const h = s.held.get(key);
        s.held.delete(key);
        s.held.set(runId, { runId, at: h?.at ?? this.now() });
      },
      release: () => {
        if (used) return;
        used = true;
        s.held.delete(key);
        this.kick(tenantId);
      },
    };
  }

  /** Grants a slot, queues the caller, or throws `OverloadError` (429 + Retry-After). */
  async admit(tenantId: string, opts: { priority?: Priority } = {}): Promise<Ticket> {
    const priority = opts.priority ?? "normal";
    const s = this.st(tenantId);
    if (s.waiters.length === 0) {
      const t = await this.locked(s, async () => {
        if (s.waiters.length > 0) return null;
        const n = await this.running(tenantId, s);
        if (n >= this.maxRunning) return null;
        return this.grantNow(tenantId, s, n);
      });
      if (t) return t;
    }
    return this.enqueue(tenantId, s, priority);
  }

  private grantNow(tenantId: string, s: TenantState, runningBefore: number): Ticket {
    const key = `r:${++this.seq}`;
    s.held.set(key, { runId: null, at: this.now() });
    s.peakRunning = Math.max(s.peakRunning, runningBefore + 1);
    this.admitted++;
    return this.ticket(tenantId, s, key);
  }

  private enqueue(tenantId: string, s: TenantState, priority: Priority): Promise<Ticket> {
    const full = s.waiters.length >= this.maxQueued;
    const globalFull = this.queuedGlobal >= this.maxQueuedGlobal;
    if (full || globalFull) {
      // A higher-priority arrival displaces the worst waiter of its own tenant rather than being refused.
      const worst = full ? this.worst(s) : undefined;
      if (!worst || RANK[priority] >= RANK[worst.priority] || globalFull) {
        const kind = full ? "TENANT_QUEUE_FULL" : "GLOBAL_QUEUE_FULL";
        this.count(kind);
        throw new OverloadError(
          kind,
          full
            ? "Too many investigations are waiting for this tenant."
            : "The service is at its queue limit.",
          this.retryAfter(),
        );
      }
      this.removeWaiter(s, worst);
      this.count("QUEUE_EVICTED");
      worst.fail(
        new OverloadError(
          "QUEUE_EVICTED",
          "Displaced by a higher-priority investigation.",
          this.retryAfter(),
        ),
      );
    }
    return new Promise<Ticket>((grant, fail) => {
      const w: Waiter = {
        priority,
        seq: ++this.seq,
        enqueuedAt: this.now(),
        grant,
        fail,
        timer: setTimeout(() => {
          if (!s.waiters.includes(w)) return;
          this.removeWaiter(s, w);
          this.count("QUEUE_TIMEOUT");
          fail(
            new OverloadError(
              "QUEUE_TIMEOUT",
              "No investigation slot became free in time.",
              this.retryAfter(),
            ),
          );
        }, this.queueTimeoutMs),
      };
      w.timer.unref();
      s.waiters.push(w);
      this.queuedGlobal++;
      this.peakQueuedGlobal = Math.max(this.peakQueuedGlobal, this.queuedGlobal);
      this.kick(tenantId);
    });
  }

  private worst(s: TenantState): Waiter | undefined {
    let w: Waiter | undefined;
    for (const x of s.waiters)
      if (!w || RANK[x.priority] > RANK[w.priority] || (x.priority === w.priority && x.seq > w.seq)) w = x;
    return w;
  }
  private removeWaiter(s: TenantState, w: Waiter): void {
    const i = s.waiters.indexOf(w);
    if (i >= 0) {
      s.waiters.splice(i, 1);
      this.queuedGlobal--;
    }
    clearTimeout(w.timer);
  }

  /** Wake the pump for a tenant (a slot may have freed). Also re-arms the occupancy poll while anyone waits. */
  kick(tenantId: string): void {
    const s = this.tenants.get(tenantId);
    if (!s || s.waiters.length === 0 || s.pumping) return;
    s.pumping = true;
    void this.pump(tenantId, s).finally(() => {
      s.pumping = false;
      if (s.waiters.length > 0 && !s.timer) {
        s.timer = setTimeout(() => {
          s.timer = null;
          this.kick(tenantId);
        }, this.pollMs);
        s.timer.unref();
      }
    });
  }

  private async pump(tenantId: string, s: TenantState): Promise<void> {
    await this.locked(s, async () => {
      while (s.waiters.length > 0) {
        let n: number;
        try {
          n = await this.running(tenantId, s);
        } catch {
          return; // occupancy unreadable: keep waiting; the timeout bounds the wait
        }
        if (n >= this.maxRunning) return;
        const next = [...s.waiters].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq)[0]!;
        this.removeWaiter(s, next);
        next.grant(this.grantNow(tenantId, s, n));
      }
    });
  }

  stats(): AdmissionStats {
    const tenants: AdmissionStats["tenants"] = {};
    for (const [id, s] of this.tenants)
      tenants[id] = { running: s.lastRunning, queued: s.waiters.length, peakRunning: s.peakRunning };
    return {
      queuedGlobal: this.queuedGlobal,
      peakQueuedGlobal: this.peakQueuedGlobal,
      admitted: this.admitted,
      rejected: { ...this.rejected },
      tenants,
    };
  }

  /** Stop timers (tests, shutdown). Waiting submissions are refused. */
  close(): void {
    for (const s of this.tenants.values()) {
      if (s.timer) clearTimeout(s.timer);
      for (const w of [...s.waiters]) {
        this.removeWaiter(s, w);
        w.fail(new OverloadError("QUEUE_TIMEOUT", "Shutting down.", 1));
      }
    }
  }
}
