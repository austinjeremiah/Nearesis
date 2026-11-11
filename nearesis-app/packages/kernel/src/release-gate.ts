import { randomUUID } from "node:crypto";
import type { Session } from "./auth.ts";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { writeAudit } from "./journal.ts";

/** ch.12 "Security release blockers": any open finding in one of these classes is NO GO. */
export const NO_GO_CLASSES = [
  "tenant_leak",
  "public_secret",
  "mainnet_action",
  "unverified_tee_proof",
  "canvas_code_execution",
  "unbounded_agent_spawn",
  "plugin_egress",
] as const;
export type NoGoClass = (typeof NO_GO_CLASSES)[number];
export type Severity = "critical" | "high" | "medium" | "low";

export interface ReleaseFinding {
  id: string;
  /** A NO-GO class, or `other` for any ordinary weakness. */
  class: NoGoClass | "other";
  severity: Severity;
  title: string;
  /** The weakness is written down (a waiver is only possible for a documented weakness). */
  documented: boolean;
  /** Any other property a caller attaches (for example a `waiver: true` flag) is ignored. */
  [extra: string]: unknown;
}

export interface WaiverInput {
  findingId: string;
  findingClass: ReleaseFinding["class"];
  severity: Severity;
  rationale: string;
  reviewerId: string;
  independentReviewRef: string;
  expiresAt?: string;
}

export interface WaiverRecord {
  id: string;
  findingId: string;
  signerId: string;
  signerKind: string;
  reviewerId: string;
  independentReviewRef: string;
  signedAt: string;
}

export interface GateDecision {
  decision: "GO" | "HOLD" | "NO_GO";
  reasons: Array<{ findingId: string; rule: "NO_GO_CLASS" | "CRITICAL" | "UNWAIVED" | "WAIVER_INVALID" }>;
  acceptedWaivers: WaiverRecord[];
}

const isNoGo = (f: Pick<ReleaseFinding, "class" | "severity">): boolean =>
  f.severity === "critical" || (NO_GO_CLASSES as readonly string[]).includes(f.class);

/**
 * The release gate evaluator and the waiver path. Waiver authority is read from the stored record written by the
 * database function (server-resolved human signer, independent human reviewer), never from a field on the finding.
 */
export class ReleaseGate {
  constructor(
    private readonly db: Db,
    readonly policy: { auditRetentionDays: number } = { auditRetentionDays: 365 },
  ) {}

  private ctx(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind };
  }

  private async refuse(s: Session, input: WaiverInput, reasonCode: string): Promise<never> {
    await this.db.tx(this.ctx(s), (tx) =>
      writeAudit(tx, {
        orgId: s.principal.orgId,
        actorId: s.userId,
        action: "release_gate.waiver_refused",
        subject: input.findingId,
        outcome: "denied",
        reasonCode,
        detail: { principalKind: s.principal.kind },
      }),
    );
    throw new KernelError("FORBIDDEN", reasonCode, "The waiver was refused.");
  }

  /** Signs a waiver. Refused (and audited) unless a human owner/admin signs a non-critical, documented finding. */
  async signWaiver(s: Session, input: WaiverInput, documented = true): Promise<WaiverRecord> {
    if (s.principal.kind !== "human") return this.refuse(s, input, "AGENT_CANNOT_WAIVE");
    if (input.severity === "critical" || input.findingClass !== "other")
      return this.refuse(s, input, "CRITICAL_NOT_WAIVABLE");
    if (!documented) return this.refuse(s, input, "WEAKNESS_NOT_DOCUMENTED");
    const id = randomUUID();
    try {
      await this.db.tx(this.ctx(s), async (tx) => {
        await tx.query("SELECT release_waiver_sign($1,$2,$3,$4,$5,$6,$7,$8)", [
          id,
          input.findingId,
          input.findingClass,
          input.severity,
          input.rationale,
          input.reviewerId,
          input.independentReviewRef,
          input.expiresAt ?? null,
        ]);
        await writeAudit(tx, {
          orgId: s.principal.orgId,
          actorId: s.userId,
          action: "release_gate.waiver_signed",
          subject: input.findingId,
          outcome: "ok",
          detail: {
            waiverId: id,
            reviewerId: input.reviewerId,
            independentReviewRef: input.independentReviewRef,
          },
        });
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "42501") return this.refuse(s, input, "WAIVER_NOT_AUTHORISED");
      if (code === "23514") return this.refuse(s, input, "CRITICAL_NOT_WAIVABLE");
      throw e;
    }
    return (await this.waivers(s)).find((w) => w.id === id)!;
  }

  async waivers(s: Session): Promise<WaiverRecord[]> {
    const r = await this.db.tx(this.ctx(s), (tx) =>
      tx.query(
        `SELECT id, finding_id, signer_id, signer_kind, reviewer_id, independent_review_ref, signed_at, expires_at
           FROM release_waivers ORDER BY signed_at`,
      ),
    );
    return r.rows
      .filter((x) => !x.expires_at || new Date(x.expires_at).getTime() > Date.now())
      .map((x) => ({
        id: x.id as string,
        findingId: x.finding_id as string,
        signerId: x.signer_id as string,
        signerKind: x.signer_kind as string,
        reviewerId: x.reviewer_id as string,
        independentReviewRef: x.independent_review_ref as string,
        signedAt: new Date(x.signed_at as string).toISOString(),
      }));
  }

  /**
   * NO_GO for any NO-GO class or critical finding (a waiver never changes that), HOLD for an ordinary finding without a
   * valid stored waiver, GO otherwise.
   */
  async evaluate(s: Session, findings: ReleaseFinding[]): Promise<GateDecision> {
    const stored = await this.waivers(s);
    const reasons: GateDecision["reasons"] = [];
    const accepted: WaiverRecord[] = [];
    for (const f of findings) {
      if (isNoGo(f)) {
        reasons.push({ findingId: f.id, rule: f.severity === "critical" ? "CRITICAL" : "NO_GO_CLASS" });
        if (stored.some((w) => w.findingId === f.id))
          reasons.push({ findingId: f.id, rule: "WAIVER_INVALID" });
        continue;
      }
      const w = stored.find(
        (x) => x.findingId === f.id && x.signerKind === "human" && x.reviewerId !== x.signerId,
      );
      if (f.documented && w) accepted.push(w);
      else reasons.push({ findingId: f.id, rule: "UNWAIVED" });
    }
    const decision = reasons.some((r) => r.rule === "NO_GO_CLASS" || r.rule === "CRITICAL")
      ? "NO_GO"
      : reasons.length
        ? "HOLD"
        : "GO";
    return { decision, reasons, acceptedWaivers: accepted };
  }

  /** Audit retention: events inside the configured window must still exist and the table must be append-only. */
  async auditRetention(
    s: Session,
  ): Promise<{ oldestKept: string | null; retentionDays: number; withinPolicy: boolean }> {
    const r = await this.db.tx(this.ctx(s), (tx) =>
      tx.query<{ oldest: Date | null }>("SELECT min(occurred_at) AS oldest FROM audit_events"),
    );
    const oldest = r.rows[0]?.oldest ?? null;
    return {
      oldestKept: oldest ? new Date(oldest).toISOString() : null,
      retentionDays: this.policy.auditRetentionDays,
      withinPolicy: this.policy.auditRetentionDays >= 365,
    };
  }
}
