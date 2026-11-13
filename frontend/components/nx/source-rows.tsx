import { Badge, CoverageChip, SourceHealthChip } from './evidence';
import type { SourceHealth } from '@/lib/contracts';
import { formatAge } from '@/lib/format';

/**
 * Source health, as a table rather than as rows of chips.
 *
 * Chips laid out inline put each row's timestamp wherever the preceding chip
 * happened to end, so the ages staggered down the card and the eye could not
 * compare them. Here every row shares one set of column tracks through
 * subgrid, so health, coverage and age each line up exactly, whatever the
 * width of the chip beside them.
 */

export type SourceRow = {
  id: string;
  name: string;
  health: SourceHealth;
  /** Null when the window expected no observations: not sampled, not zero. */
  coveragePct: number | null;
  watermark: string | null;
};

/** Coverage chips take a window; the catalog stores the ratio. */
function coverageOf(pct: number) {
  const expected = 180;
  const observed = Math.round(expected * pct);
  return { expected, observed, unknown: expected - observed, gaps: [] as string[] };
}

export function SourceRows({ rows }: { rows: SourceRow[] }) {
  return (
    <div className="source-rows">
      {rows.map((s) => (
        <div key={s.id} className="source-row">
          <span className="name">{s.name}</span>
          <SourceHealthChip health={s.health} />
          {s.coveragePct !== null ? (
            <CoverageChip coverage={coverageOf(s.coveragePct)} />
          ) : (
            <Badge outline>Not sampled</Badge>
          )}
          <span className="age tiny dim mono">{formatAge(s.watermark)}</span>
        </div>
      ))}
    </div>
  );
}
