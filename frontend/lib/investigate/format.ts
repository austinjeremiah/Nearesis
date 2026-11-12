/** Small amounts keep their digits: a $0.0033 charge must not read as $0.00. */
export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '$0';
  if (Math.abs(v) >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}
