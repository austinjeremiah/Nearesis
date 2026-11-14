import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Principal } from "@nearesis/contracts";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { IntegrityGuard } from "./integrity.ts";
import { writeAudit } from "./journal.ts";

export type SubjectKind = "capsule" | "inference_response" | "evidence_item";
export type VerificationStateValue = "verified" | "unverified" | "failed";

/** The attestation checks a verifier must have passed before a result may read `verified` (ch.12, ch.14). */
export const REQUIRED_CHECKS = [
  "tdx_quote_non_debug",
  "measurement_accepted",
  "signer_match",
  "evidence_fresh",
  "response_binding",
] as const;

/** A verifier's result as submitted by the verifier service (the shape of `VerificationResult` plus its binding). */
export interface VerifierResult {
  status: "verified" | "failed" | "unattested_dev" | "unsupported";
  checks: Array<{ name: string; passed: boolean }>;
  /** SHA-256 of the response the attestation evidence was issued for. Must equal the response being recorded. */
  boundResponseSha256: string;
  reason?: string;
}

export interface RecordInput {
  workspaceId: string;
  subjectKind: SubjectKind;
  subjectRef: string;
  /** SHA-256 of the response (or artefact) the verifier checked. */
  responseSha256: string;
  result: VerifierResult;
}

export interface Badge {
  label: "verified" | "unverified" | "failed";
  /** The visible text a publication must show next to the claim. */
  text: string;
}

const BADGES: Record<VerificationStateValue, Badge> = {
  verified: { label: "verified", text: "Verified (attestation checked)" },
  unverified: { label: "unverified", text: "Unverified" },
  failed: { label: "failed", text: "Verification failed" },
};

/** The state a verifier result may produce. Anything short of every required check passing is never `verified`. */
export function stateFor(
  result: VerifierResult,
  responseSha256: string,
): { state: VerificationStateValue; reason: string | null } {
  if (result.boundResponseSha256 !== responseSha256)
    return { state: "failed", reason: "RESPONSE_BINDING_MISMATCH" };
  if (result.status === "failed") return { state: "failed", reason: result.reason ?? "VERIFICATION_FAILED" };
  if (result.status === "unattested_dev" || result.status === "unsupported")
    return { state: "unverified", reason: result.status };
  const passed = new Set(result.checks.filter((c) => c.passed).map((c) => c.name));
  const missing = REQUIRED_CHECKS.filter((n) => !passed.has(n));
  if (missing.length || result.checks.some((c) => !c.passed))
    return { state: "failed", reason: `CHECKS_NOT_PASSED:${missing.join(",") || "some"}` };
  return { state: "verified", reason: null };
}

interface Row {
  id: string;
  org_id: string;
  workspace_id: string;
  subject_kind: SubjectKind;
  subject_ref: string;
  state: VerificationStateValue;
  reason: string | null;
  response_sha256: string;
  verifier_id: string;
  created_at: Date;
  row_hmac: string;
}

/**
 * The only writer of verification state. Writing needs (1) a service principal, (2) a registered verifier identity, both
 * enforced again by the database function, and (3) a result whose binding matches the response. Each row carries an HMAC
 * under a key the database never sees; reading for publication recomputes it, so a hand-edited or forged row is refused.
 */
export class VerifiedStateService {
  private readonly integrity: IntegrityGuard;
  constructor(
    private readonly db: Db,
    private readonly key: string | undefined = process.env.NEARESIS_VERIFIED_STATE_KEY,
  ) {
    this.integrity = new IntegrityGuard(db);
  }

  private mac(r: {
    id: string;
    orgId: string;
    workspaceId: string;
    subjectKind: string;
    subjectRef: string;
    state: string;
    reason: string | null;
    responseSha256: string;
    verifierId: string;
    createdAt: string;
  }): string {
    if (!this.key || this.key.length < 32)
      throw new KernelError(
        "INTERNAL",
        "VERIFIED_STATE_UNAVAILABLE",
        "Verification state is not configured.",
      );
    return createHmac("sha256", this.key).update(canonicalJson(r)).digest("hex");
  }

  private async deny(principal: Principal, input: RecordInput, reasonCode: string): Promise<never> {
    await this.db.tx({ orgId: principal.orgId, userId: principal.actorId, actorKind: principal.kind }, (tx) =>
      writeAudit(tx, {
        orgId: principal.orgId,
        workspaceId: input.workspaceId,
        actorId: principal.actorId,
        action: "verified_state.denied",
        subject: `${input.subjectKind}:${input.subjectRef}`,
        outcome: "denied",
        reasonCode,
        detail: { principalKind: principal.kind },
      }),
    );
    throw new KernelError("FORBIDDEN", reasonCode, "Only the verifier may set verification state.");
  }

  /** Verifier-originated write. Every other caller is refused and audited. */
  async record(
    principal: Principal,
    input: RecordInput,
  ): Promise<{ id: string; state: VerificationStateValue }> {
    if (principal.kind !== "service") return this.deny(principal, input, "NOT_A_VERIFIER");
    const { state, reason } = stateFor(input.result, input.responseSha256);
    if (reason === "RESPONSE_BINDING_MISMATCH") {
      await this.db.tx({ orgId: principal.orgId, userId: principal.actorId, actorKind: "service" }, (tx) =>
        writeAudit(tx, {
          orgId: principal.orgId,
          workspaceId: input.workspaceId,
          actorId: principal.actorId,
          action: "verified_state.binding_mismatch",
          subject: `${input.subjectKind}:${input.subjectRef}`,
          outcome: "denied",
          reasonCode: "RESPONSE_BINDING_MISMATCH",
        }),
      );
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "RESPONSE_BINDING_MISMATCH",
        "The evidence was issued for a different response.",
      );
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const hmac = this.mac({
      id,
      orgId: principal.orgId,
      workspaceId: input.workspaceId,
      subjectKind: input.subjectKind,
      subjectRef: input.subjectRef,
      state,
      reason,
      responseSha256: input.responseSha256,
      verifierId: principal.actorId,
      createdAt,
    });
    try {
      await this.db.tx({ orgId: principal.orgId, userId: principal.actorId, actorKind: "service" }, (tx) =>
        tx.query("SELECT verified_state_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
          id,
          principal.orgId,
          input.workspaceId,
          input.subjectKind,
          input.subjectRef,
          state,
          reason,
          input.responseSha256,
          hmac,
          createdAt,
        ]),
      );
    } catch (e) {
      if ((e as { code?: string }).code === "42501") return this.deny(principal, input, "NOT_A_VERIFIER");
      throw e;
    }
    return { id, state };
  }

  private async latest(
    principal: { orgId: string; userId: string; actorKind?: "human" | "agent" | "service" },
    workspaceId: string,
    kind: SubjectKind,
    ref: string,
  ): Promise<Row | undefined> {
    return this.db.tx(
      principal,
      async (tx) =>
        (
          await tx.query<Row>(
            `SELECT * FROM verification_states WHERE workspace_id = $1 AND subject_kind = $2 AND subject_ref = $3
           ORDER BY created_at DESC, id DESC LIMIT 1`,
            [workspaceId, kind, ref],
          )
        ).rows[0],
    );
  }

  /**
   * Publication gate. Returns the state and the label the publication must display. A stored row whose HMAC does not
   * verify (hand-edited, or inserted outside the verifier path) is quarantined and the gate refuses with `integrity_error`.
   * No row means `unverified`, publishable only with that label. No input can produce a `verified` label except a row
   * written through `record`.
   */
  async gate(
    session: { principal: Principal; userId: string },
    workspaceId: string,
    kind: SubjectKind,
    ref: string,
  ): Promise<{ publishable: true; state: VerificationStateValue; badge: Badge; verifierId: string | null }> {
    const ctx = { orgId: session.principal.orgId, userId: session.userId, actorKind: session.principal.kind };
    const row = await this.latest(ctx, workspaceId, kind, ref);
    if (!row) return { publishable: true, state: "unverified", badge: BADGES.unverified, verifierId: null };
    const expected = this.mac({
      id: row.id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      subjectKind: row.subject_kind,
      subjectRef: row.subject_ref,
      state: row.state,
      reason: row.reason,
      responseSha256: row.response_sha256,
      verifierId: row.verifier_id,
      createdAt: new Date(row.created_at).toISOString(),
    });
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(row.row_hmac, "hex");
    const ok = a.length === b.length && timingSafeEqual(a, b);
    await this.integrity.verify(
      { orgId: row.org_id, userId: null },
      "evidence_item",
      `verification:${row.id}`,
      sha256Hex(expected),
      sha256Hex(ok ? expected : row.row_hmac),
    );
    return { publishable: true, state: row.state, badge: BADGES[row.state], verifierId: row.verifier_id };
  }
}
