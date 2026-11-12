import type { StructuredResult, VerificationResult } from "@nearesis/contracts";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { VerifiedStateService, VerificationStateValue, Badge } from "./verified-state.ts";

/**
 * Production call site of the verified-state service for model results (FND-072, ch.12). The recorder holds the
 * identity of the registered verifier service (`NEARESIS_VERIFIER_ACTOR_ID`, provisioned in `verifier_identities` by an
 * operator). It never decides a state itself: it submits the provider's own `verifyResponse` outcome, bound to the
 * response it was issued for, and the service plus the database function derive the state. Without a configured verifier
 * identity nothing is recorded and every result reads back as `unverified`.
 */
export interface InferenceVerificationOptions {
  /** Registered verifier identity; defaults to `NEARESIS_VERIFIER_ACTOR_ID`. */
  verifierId?: string | null;
  /** Receives one line per failed recording (never content). */
  log?: (line: Record<string, unknown>) => void;
}

const SHA = /^[0-9a-f]{64}$/;

export class InferenceVerification {
  private readonly verifierId: string | null;
  private readonly log: (line: Record<string, unknown>) => void;
  constructor(
    private readonly service: VerifiedStateService,
    o: InferenceVerificationOptions = {},
  ) {
    this.verifierId =
      (o.verifierId === undefined ? process.env.NEARESIS_VERIFIER_ACTOR_ID : o.verifierId) || null;
    this.log = o.log ?? ((l) => process.stderr.write(JSON.stringify(l) + "\n"));
  }

  get enabled(): boolean {
    return this.verifierId !== null;
  }

  /** Hash the verifier binds the attestation to: the provider's raw response hash, else the canonical output. */
  static responseHash(r: StructuredResult<unknown>): string {
    return SHA.test(r.rawResponseSha256) ? r.rawResponseSha256 : sha256Hex(canonicalJson(r.output));
  }

  /** Runs the provider's verification for `result` and records the outcome under (workspace, inference key). */
  async record(a: {
    orgId: string;
    workspaceId: string;
    key: string;
    result: StructuredResult<unknown>;
    verify: (r: StructuredResult<unknown>) => Promise<VerificationResult>;
  }): Promise<VerificationStateValue | null> {
    if (!this.verifierId) return null;
    const responseSha256 = InferenceVerification.responseHash(a.result);
    try {
      const v = await a.verify(a.result);
      const out = await this.service.record(
        { kind: "service", actorId: this.verifierId, orgId: a.orgId },
        {
          workspaceId: a.workspaceId,
          subjectKind: "inference_response",
          subjectRef: a.key,
          responseSha256,
          result: {
            status: v.status,
            checks: v.checks.map((c) => ({ name: c.name, passed: c.passed })),
            boundResponseSha256: responseSha256,
            ...(v.reason ? { reason: v.reason } : {}),
          },
        },
      );
      return out.state;
    } catch (e) {
      this.log({
        msg: "verified_state.record_failed",
        subject: "inference_response",
        reasonCode: (e as { reasonCode?: string }).reasonCode ?? "RECORD_FAILED",
      });
      return null;
    }
  }

  /** The state and badge a publication of this result must show. Missing, unverifiable or failing reads are `unverified`. */
  async labelFor(a: {
    orgId: string;
    workspaceId: string;
    key: string;
  }): Promise<{ state: VerificationStateValue; badge: Badge; verifierId: string | null }> {
    try {
      const g = await this.service.gate(
        {
          principal: { kind: "service", actorId: this.verifierId ?? ZERO, orgId: a.orgId },
          userId: this.verifierId ?? ZERO,
        },
        a.workspaceId,
        "inference_response",
        a.key,
      );
      return { state: g.state, badge: g.badge, verifierId: g.verifierId };
    } catch (e) {
      // a stored row that fails its integrity check (or an unconfigured key) must never read as verified
      this.log({
        msg: "verified_state.read_failed",
        reasonCode: (e as { reasonCode?: string }).reasonCode ?? "READ_FAILED",
      });
      return { state: "failed", badge: { label: "failed", text: "Verification failed" }, verifierId: null };
    }
  }
}
const ZERO = "00000000-0000-0000-0000-000000000000";
