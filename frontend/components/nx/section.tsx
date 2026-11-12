import type { ReactNode } from 'react';

/**
 * Section header, taken from the marketing site's `.section-title-flex`: a solid
 * ink bar with the title set small and uppercase on the left and the section
 * number on the right, followed by the dot rule (a hairline pinned between two
 * small squares).
 *
 * Using the same device here is what makes the product read as the same company
 * as the landing page, rather than a generic dashboard that happens to share a
 * palette.
 */
export function SectionBar({
  title,
  number,
  action,
}: {
  title: string;
  /** Zero-padded on the landing page: 001, 002, 003. */
  number?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div className="section-bar">
        <h2>{title}</h2>
        {number && <span className="n">{number}</span>}
      </div>
      <div className="dot-rule" aria-hidden="true">
        <span className="sq" />
        <span className="ln" />
        <span className="sq" />
      </div>
      {action && <div className="section-action">{action}</div>}
    </div>
  );
}
