import type { AttestationCheck, VerificationResult } from "@nearesis/contracts";
import { InferenceError } from "./errors.ts";

export const REQUIRED_CHECKS: ReadonlyArray<AttestationCheck["name"]> = [
  "tdx_quote_non_debug",
  "measurement_accepted",
  "signer_match",
  "evidence_fresh",
  "response_binding",
];

export interface PublishableArtifact {
  id?: string;
  verification: VerificationResult | null | undefined;
}

export interface GateDecision {
  allowed: boolean;
  status: string;
  reasons: string[];
}

/** Pure decision (fail-closed): allowed only if status is "verified", verified is true and all five checks passed. */
export function evaluatePublication(artifact: PublishableArtifact): GateDecision {
  const v = artifact.verification;
  const reasons: string[] = [];
  if (!v) return { allowed: false, status: "missing", reasons: ["NO_VERIFICATION_RESULT"] };
  if (v.status !== "verified") reasons.push(`STATUS_${v.status.toUpperCase()}`);
  if (v.verified !== true) reasons.push("VERIFIED_FALSE");
  if (v.reason) reasons.push(`REASON_${v.reason}`);
  for (const name of REQUIRED_CHECKS) {
    const c = v.checks.find((x) => x.name === name);
    if (!c) reasons.push(`CHECK_MISSING_${name}`);
    else if (c.passed !== true) reasons.push(`CHECK_FAILED_${name}`);
  }
  const allowed =
    v.status === "verified" && v.verified === true && !reasons.some((r) => r.startsWith("CHECK_"));
  return { allowed, status: v.status, reasons: allowed ? [] : reasons };
}

/** Throws PUBLICATION_REFUSED unless the artifact carries a genuine `verified` result. */
export function assertPublishable(artifact: PublishableArtifact): void {
  const d = evaluatePublication(artifact);
  if (!d.allowed) {
    throw new InferenceError(
      "PUBLICATION_REFUSED",
      `artifact not publishable (${d.status}): ${d.reasons.join(",")}`,
    );
  }
}
