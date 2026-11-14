import type { ReactNode } from "react";
import { CLAIM_LABEL, type ClaimClass } from "./model.ts";
import s from "./thesis.module.css";

/** Epistemic class marker: shape and border style differ per class, so it does not rely on colour alone. */
export function ClaimTag({ cls }: { cls: ClaimClass }) {
  return (
    <span className={s.tag} data-class={cls} data-testid={`claim-tag-${cls}`}>
      <span className={s.tagMark} aria-hidden="true" />
      {CLAIM_LABEL[cls]}
    </span>
  );
}

export function Claim({ cls, children, testId }: { cls: ClaimClass; children: ReactNode; testId?: string }) {
  return (
    <div className={s.claim} data-class={cls} data-testid={testId}>
      <ClaimTag cls={cls} />
      <div>{children}</div>
    </div>
  );
}

export function ClaimLegend() {
  return (
    <div className={s.legend} aria-label="Claim classes" data-testid="claim-legend">
      {(Object.keys(CLAIM_LABEL) as ClaimClass[]).map((c) => (
        <ClaimTag key={c} cls={c} />
      ))}
    </div>
  );
}
