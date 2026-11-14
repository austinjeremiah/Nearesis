/**
 * Preregistration, evaluation and publication in the required order (ch.25 steps 2, 10, 11, 12; ch.02 "Preregistration
 * protocol"; ch.16b B08). The lifecycle enforces: owner-approved freeze, then the single lockbox evaluation, then the
 * audit, then publication. An evaluation that precedes the freeze is labelled `post-hoc registration`, which caps
 * evidence strength below `pre_registered`. Mainnet writes are never performed here: the chain port refuses them.
 */
import { scanForbidden, type ForbiddenHit } from "./claims.ts";

export type RegistrationLabel = "pre_registered" | "post-hoc registration";

export type LifecycleEventKind =
  | "preregistration.freeze_refused"
  | "preregistration.frozen"
  | "lockbox.opened"
  | "audit.completed"
  | "research.published"
  | "publication.blocked"
  | "chain.write_refused";

export interface LifecycleEvent {
  seq: number;
  at: string;
  kind: LifecycleEventKind;
  data: Record<string, unknown>;
}

export class PublicationBlocked extends Error {
  constructor(
    readonly reason_code:
      "NO_OWNER_APPROVED_FREEZE" | "NO_EVALUATION" | "AUDIT_MISSING" | "AUDIT_FAILED" | "FORBIDDEN_CLAIM",
    message: string,
    readonly hits: Array<ForbiddenHit & { surface: string }> = [],
  ) {
    super(message);
  }
}
export class FreezeRefused extends Error {
  readonly reason_code = "OWNER_APPROVAL_REQUIRED";
}
export class ChainWriteRefused extends Error {
  readonly reason_code = "MAINNET_WRITE_HUMAN_ONLY";
}

export interface OwnerApproval {
  approvedBy: string;
  /** role resolved by the kernel for `approvedBy` (never client supplied by the lifecycle itself) */
  role: "owner" | "admin" | "analyst" | "viewer";
}

/** The chain adapter the flow is given. Every call is logged; a mainnet network is refused before any I/O. */
export class GuardedChain {
  readonly log: Array<{ at: string; network: string; action: string; outcome: "refused" | "recorded" }> = [];
  constructor(private readonly clock: () => string) {}
  write(network: string, action: string): never {
    const outcome = "refused" as const;
    this.log.push({ at: this.clock(), network, action, outcome });
    throw new ChainWriteRefused(`${action} on ${network} is a human-only step`);
  }
}

export interface PublicationDecision {
  label: RegistrationLabel;
  evidenceStrengthCap: "pre_registered" | "exploratory";
  notes: string[];
  events: LifecycleEvent[];
}

export class ThesisLifecycle {
  readonly events: LifecycleEvent[] = [];
  readonly chain: GuardedChain;
  private frozenSeq: number | null = null;
  private lockboxSeq: number | null = null;
  private auditSeq: number | null = null;
  private auditOk = false;
  private frozenHash: string | null = null;
  constructor(private readonly clock: () => string = () => new Date().toISOString()) {
    this.chain = new GuardedChain(this.clock);
  }
  private emit(kind: LifecycleEventKind, data: Record<string, unknown>): number {
    const seq = this.events.length + 1;
    this.events.push({ seq, at: this.clock(), kind, data });
    return seq;
  }
  /** Freezes the preregistration hash. Only an owner approval freezes; anything else is refused and recorded. */
  freeze(preregistrationHash: string, approval: OwnerApproval | null): void {
    if (!approval || approval.role !== "owner") {
      this.emit("preregistration.freeze_refused", {
        preregistrationHash,
        reason_code: "OWNER_APPROVAL_REQUIRED",
        role: approval?.role ?? null,
      });
      throw new FreezeRefused("freezing the preregistration needs an owner approval");
    }
    this.frozenHash = preregistrationHash;
    this.frozenSeq = this.emit("preregistration.frozen", {
      preregistrationHash,
      approvedBy: approval.approvedBy,
    });
  }
  openLockbox(info: { evaluationHash: string }): void {
    this.lockboxSeq = this.emit("lockbox.opened", { ...info, frozenBefore: this.frozenSeq !== null });
  }
  completeAudit(info: { ok: boolean; detail: string }): void {
    this.auditOk = info.ok;
    this.auditSeq = this.emit("audit.completed", info);
  }
  get label(): RegistrationLabel {
    return this.frozenSeq !== null && this.lockboxSeq !== null && this.frozenSeq < this.lockboxSeq
      ? "pre_registered"
      : "post-hoc registration";
  }
  /** Gate for publication. Throws PublicationBlocked unless an owner-approved freeze, an evaluation and a passing audit exist. */
  publish(texts: Record<string, string> = {}): PublicationDecision {
    const block = (
      code: PublicationBlocked["reason_code"],
      msg: string,
      hits: Array<ForbiddenHit & { surface: string }> = [],
    ): never => {
      this.emit("publication.blocked", { reason_code: code, classes: [...new Set(hits.map((h) => h.cls))] });
      throw new PublicationBlocked(code, msg, hits);
    };
    if (this.frozenSeq === null) block("NO_OWNER_APPROVED_FREEZE", "no owner-approved freeze exists");
    if (this.lockboxSeq === null) block("NO_EVALUATION", "no evaluation was run");
    if (this.auditSeq === null) block("AUDIT_MISSING", "no audit was completed");
    if (!this.auditOk) block("AUDIT_FAILED", "audit did not pass");
    const hits = Object.entries(texts).flatMap(([surface, t]) =>
      scanForbidden(t).map((h) => ({ ...h, surface })),
    );
    if (hits.length)
      block(
        "FORBIDDEN_CLAIM",
        `forbidden claim class(es): ${[...new Set(hits.map((h) => h.cls))].join(", ")}`,
        hits,
      );
    const label = this.label;
    this.emit("research.published", { label, preregistrationHash: this.frozenHash });
    return {
      label,
      evidenceStrengthCap: label === "pre_registered" ? "pre_registered" : "exploratory",
      notes:
        label === "pre_registered"
          ? []
          : [
              "Registration label: post-hoc registration. The final evaluation ran before the preregistration was frozen, so this result carries exploratory evidence strength and is not pre-registered.",
            ],
      events: [...this.events],
    };
  }
  /** Order of the four ordered event kinds that did occur, for assertions. */
  orderOf(): LifecycleEventKind[] {
    return this.events.map((e) => e.kind);
  }
}
