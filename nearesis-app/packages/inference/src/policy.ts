import { readFileSync } from "node:fs";
import type { NearAiVerificationPolicy } from "./near-verify.ts";

/** Load the written verification policy shipped with the package (policy/near-ai-policy.json). */
export function loadDefaultPolicy(): NearAiVerificationPolicy {
  const raw = JSON.parse(
    readFileSync(new URL("../policy/near-ai-policy.json", import.meta.url), "utf8"),
  ) as NearAiVerificationPolicy;
  return {
    acceptedTcbStatuses: raw.acceptedTcbStatuses,
    acceptedComposeHashes: raw.acceptedComposeHashes,
    acceptedOsImageHashes: raw.acceptedOsImageHashes,
    maxEvidenceAgeMs: raw.maxEvidenceAgeMs,
    maxVerifyDelayMs: raw.maxVerifyDelayMs,
    gpuEvidence: raw.gpuEvidence,
  };
}
