/**
 * Comparison conclusions (R4, research amendment 002). Four conclusions are kept apart:
 *  1. "lower observed forecast error": `conclusion.observed_candidate_lower_error`, a descriptive fact with no
 *     significance wording;
 *  2. "evidence supports a statistically meaningful difference": only when `conclusion.state` is
 *     `evidence_supports_difference` AND `status` is VALID AND `significance_claim_allowed`;
 *  3. "evidence insufficient to distinguish the models";
 *  4. "comparison method not validated" (and "invalid input"), with `inference.reason`.
 * Significance wording is never derived from p-values (`p_adjusted`, `dm.p_one_sided`), and nothing is causal.
 */
import type { ResearchRunArtifact } from "@nearesis/contracts";
import s from "./thesis.module.css";

type Comparison = ResearchRunArtifact["estimates"]["primary"];
export type Inference = NonNullable<Comparison["inference"]>;

export type ConclusionKind =
  | "observed_lower_error"
  | "meaningful_difference"
  | "insufficient"
  | "not_validated"
  | "invalid_input"
  | "no_inference";

export interface ConclusionLabel {
  kind: ConclusionKind;
  text: string;
  detail: string | null;
}

/** The labels for one comparison, in display order. Pure, so tests and the capsule page share it. */
export function conclusionLabels(inf: Inference | undefined): ConclusionLabel[] {
  if (!inf)
    return [{ kind: "no_inference", text: "no inference record: no statistical conclusion", detail: null }];
  const out: ConclusionLabel[] = [];
  const c = inf.conclusion;
  if (c.observed_candidate_lower_error === true)
    out.push({
      kind: "observed_lower_error",
      text: "lower observed forecast error",
      detail: inf.mean_diff === null ? null : `observed mean loss difference ${inf.mean_diff.toFixed(6)}`,
    });
  const valid =
    c.state === "evidence_supports_difference" &&
    inf.status === "VALID" &&
    inf.significance_claim_allowed === true;
  if (valid)
    out.push({
      kind: "meaningful_difference",
      text: "evidence supports a statistically meaningful difference",
      detail: null,
    });
  else if (c.state === "evidence_supports_difference")
    // Contract refine forbids this; if it ever arrives, it is shown as not validated rather than as a finding.
    out.push({
      kind: "not_validated",
      text: "comparison method not validated",
      detail: `inconsistent record: status ${inf.status}`,
    });
  else if (c.state === "insufficient_to_distinguish")
    out.push({
      kind: "insufficient",
      text: "evidence insufficient to distinguish the models",
      detail: inf.reason ?? null,
    });
  else if (c.state === "comparison_method_not_validated")
    out.push({
      kind: "not_validated",
      text: "comparison method not validated",
      detail: inf.reason ?? `status ${inf.status}`,
    });
  else if (c.state === "comparison_invalid_input")
    out.push({
      kind: "invalid_input",
      text: "comparison invalid: input not usable",
      detail: inf.reason ?? `status ${inf.status}`,
    });
  return out;
}

export function ConclusionTags({ inference, testId }: { inference: Inference | undefined; testId?: string }) {
  const labels = conclusionLabels(inference);
  return (
    <span className={s.conclusions} data-testid={testId}>
      {labels.map((l) => (
        <span key={l.kind} className={s.conclusion} data-kind={l.kind} data-testid="conclusion">
          {l.text}
          {l.detail ? <span className={s.conclusionDetail}> ({l.detail})</span> : null}
        </span>
      ))}
    </span>
  );
}

interface InferenceSummaryShape {
  primaryStatisticalClaim?: string;
  methodVersion?: string;
  label?: string;
  calibration?: { resultHash?: string | null; qualified?: boolean | null };
}

/** Run-level inference summary: whether any primary statistical claim is supported, method and calibration. */
export function InferenceSummary({ run }: { run: ResearchRunArtifact }) {
  const sum = (run.estimates as { inferenceSummary?: InferenceSummaryShape }).inferenceSummary;
  const primary = run.estimates.primary.inference;
  if (!sum && !primary)
    return (
      <p className={s.sectionNote} data-testid="inference-summary">
        This run predates the inference amendment: it carries no inference record, so no statistical
        conclusion is shown.
      </p>
    );
  const claim =
    sum?.primaryStatisticalClaim ?? (primary?.significance_claim_allowed ? "supported" : "not_supported");
  return (
    <div className={s.card} data-testid="inference-summary">
      <h3 className={s.cardTitle}>Statistical inference</h3>
      <div>
        Primary statistical claim:{" "}
        <strong className={claim === "supported" ? s.ok : s.warn} data-testid="primary-claim">
          {claim === "supported" ? "supported" : "not supported"}
        </strong>
      </div>
      <div className={s.metricSub}>
        Primary comparison ({run.hypothesis.primaryComparison}, {run.hypothesis.primaryHorizon}-day):{" "}
        <ConclusionTags inference={primary} testId="primary-conclusion" />
      </div>
      <dl className={s.record}>
        <dt>Method</dt>
        <dd className={s.mono} data-testid="inference-method">
          {primary?.method.id ?? "n/a"} {sum?.methodVersion ?? primary?.method.version ?? ""}
        </dd>
        <dt>Label</dt>
        <dd data-testid="inference-label">{sum?.label ?? primary?.method.label ?? "n/a"}</dd>
        <dt>Calibration reference</dt>
        <dd className={s.mono} data-testid="calibration-hash">
          {sum?.calibration?.resultHash ?? primary?.calibration_reference?.resultHash ?? "not recorded"}
        </dd>
      </dl>
      <p className={s.metricSub}>Predictive comparisons only. No causal claim is made.</p>
    </div>
  );
}
