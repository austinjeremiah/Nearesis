import type { ReactNode } from 'react';

/**
 * The dark statistics band, lifted from the marketing site's BY THE NUMBERS
 * section: ink panel, dot field, an oversized display numeral with its unit set
 * small and green against it, and a sentence that carries the claim.
 *
 * It is the strongest device the template has, and it earns its place in the
 * product for the same reason it works on the landing page: it states a small
 * number of facts that matter, in a voice that is confident about what is known
 * and plain about what is not.
 */

export type BandStat = {
  /** The numeral. Kept as a string so "0" and "4" render identically to "72". */
  value: string;
  /** Unit or qualifier, set small and in the accent beside the numeral. */
  unit?: string;
  /** The sentence that completes the number. */
  detail: string;
  /** The one stat that leads, drawn in the accent. */
  lead?: boolean;
};

export function Band({
  eyebrow,
  lead,
  stats,
  footer,
}: {
  eyebrow: string;
  lead: string;
  stats: BandStat[];
  footer?: ReactNode;
}) {
  return (
    <section className="band" aria-label={eyebrow}>
      <span className="band-eyebrow">{eyebrow}</span>
      <p className="band-lead">{lead}</p>

      <div className="band-stats">
        {stats.map((s) => (
          <div key={s.detail} className={`band-stat ${s.lead ? 'lead' : ''}`.trim()}>
            <span className="v">
              {s.value}
              {s.unit && <span className="u">{s.unit}</span>}
            </span>
            <span className="d">{s.detail}</span>
          </div>
        ))}
      </div>

      {footer && <div className="band-foot">{footer}</div>}
    </section>
  );
}
