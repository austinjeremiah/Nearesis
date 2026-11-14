import { randomUUID } from "node:crypto";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { writeAudit } from "./journal.ts";

/** The stored artefact classes whose bytes are re-hashed on every read (ch.12 trust matrix "Compute -> evidence"). */
export type ArtefactClass =
  "archive_object" | "evidence_item" | "outbox_event" | "plugin_manifest" | "semantic_model" | "capsule";

export const INTEGRITY_REASON = "integrity_error";

/** Machine-readable integrity failure. HTTP 422 DOMAIN_INVARIANT with reasonCode `integrity_error`. */
export function integrityError(cls: ArtefactClass, _ref?: string): KernelError {
  return new KernelError(
    "DOMAIN_INVARIANT",
    INTEGRITY_REASON,
    `Stored ${cls.replace("_", " ")} failed its integrity check and is quarantined; it was not used.`,
    { retryable: false, nextAction: "Restore the artefact from a verified copy." },
  );
}

export interface IntegrityScope {
  /** Tenant of the artefact; null for platform-level artefacts. */
  orgId: string | null;
  userId?: string | null;
}

export type IntegrityState = "ok" | "quarantined";

/**
 * Verifies a stored artefact against its recorded hash on the read path. A mismatch writes a quarantine record and an
 * audit (trace) event in their own transaction (so the caller's rollback cannot erase them), then throws
 * `integrity_error`. A quarantined reference fails fast on later reads until it is restored and cleared by an operator.
 */
export class IntegrityGuard {
  constructor(private readonly db: Db) {}

  private run<T>(scope: IntegrityScope, fn: Parameters<Db["txGlobal"]>[0]): Promise<T> {
    return (
      scope.orgId
        ? this.db.tx({ orgId: scope.orgId, userId: scope.userId ?? scope.orgId, actorKind: "service" }, fn)
        : this.db.txGlobal(fn)
    ) as Promise<T>;
  }

  /** Visible integrity state of one artefact, for panels and claims that depend on it. */
  async state(scope: IntegrityScope, cls: ArtefactClass, ref: string): Promise<IntegrityState> {
    const n = await this.run<number>(
      scope,
      async (tx) =>
        (
          await tx.query(
            "SELECT 1 FROM integrity_quarantine WHERE artefact_class = $1 AND ref = $2 LIMIT 1",
            [cls, ref],
          )
        ).rows.length,
    );
    return n > 0 ? "quarantined" : "ok";
  }

  /** The caller's visible quarantine records (own tenant plus platform-level artefacts), newest first. */
  async list(
    scope: IntegrityScope,
  ): Promise<
    Array<{ artefactClass: ArtefactClass; ref: string; scope: "tenant" | "platform"; detectedAt: string }>
  > {
    const rows = await this.run<
      Array<{ artefact_class: ArtefactClass; ref: string; org_id: string | null; detected_at: Date }>
    >(
      scope,
      async (tx) =>
        (
          await tx.query(
            "SELECT artefact_class, ref, org_id, detected_at FROM integrity_quarantine ORDER BY detected_at DESC LIMIT 200",
          )
        ).rows,
    );
    return rows.map((r) => ({
      artefactClass: r.artefact_class,
      ref: r.ref,
      scope: r.org_id ? ("tenant" as const) : ("platform" as const),
      detectedAt: new Date(r.detected_at).toISOString(),
    }));
  }

  async assertNotQuarantined(scope: IntegrityScope, cls: ArtefactClass, ref: string): Promise<void> {
    if ((await this.state(scope, cls, ref)) === "quarantined") throw integrityError(cls, ref);
  }

  /** Records the violation and throws. Never returns. */
  async violation(
    scope: IntegrityScope,
    cls: ArtefactClass,
    ref: string,
    expected: string,
    actual: string,
  ): Promise<never> {
    await this.run<void>(scope, async (tx) => {
      await tx.query(
        `INSERT INTO integrity_quarantine(id, org_id, artefact_class, ref, expected_hash, actual_hash)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [randomUUID(), scope.orgId, cls, ref, expected, actual],
      );
      await writeAudit(tx, {
        orgId: scope.orgId,
        actorId: scope.userId ?? null,
        action: "integrity.violation",
        subject: `${cls}:${ref}`,
        outcome: "failed",
        reasonCode: INTEGRITY_REASON,
        detail: { artefactClass: cls, expectedHash: expected, actualHash: actual },
      });
    });
    throw integrityError(cls, ref);
  }

  /** Fails fast when already quarantined, otherwise compares hashes; a mismatch quarantines and throws. */
  async verify(
    scope: IntegrityScope,
    cls: ArtefactClass,
    ref: string,
    expected: string,
    actual: string,
  ): Promise<void> {
    await this.assertNotQuarantined(scope, cls, ref);
    if (expected !== actual) await this.violation(scope, cls, ref, expected, actual);
  }
}
