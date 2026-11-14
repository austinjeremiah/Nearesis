/**
 * Min/max bucket downsampling (keeps every spike). Mirrors the declared method `min_max_bucket`; the app still passes
 * the method and original point count through so the UI can show it (C18). Pure function, no I/O.
 */
export function minMaxBucket(
  points: Array<[number, number | null]>,
  buckets: number,
): Array<[number, number | null]> {
  if (points.length <= buckets * 2) return points;
  const out: Array<[number, number | null]> = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    let lo = from;
    let hi = from;
    let nullAt = -1;
    for (let i = from; i < to; i++) {
      const v = points[i]![1];
      if (v === null) {
        if (nullAt < 0) nullAt = i;
        continue;
      }
      const lov = points[lo]![1];
      const hiv = points[hi]![1];
      if (lov === null || v < lov) lo = i;
      if (hiv === null || v > hiv) hi = i;
    }
    if (nullAt >= 0) out.push(points[nullAt]!); // keep the break so gaps stay gaps
    const a = Math.min(lo, hi);
    const z = Math.max(lo, hi);
    out.push(points[a]!);
    if (z !== a) out.push(points[z]!);
  }
  return out;
}
