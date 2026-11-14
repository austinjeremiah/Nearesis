/**
 * Live canvas versus offline rebuild (ch.25 "One coherent demo assertion", ch.16b B06). A difference between the data
 * a live panel shows and the data a rebuild from a frozen snapshot produces is acceptable only when metadata (snapshot
 * id or watermark) explains it, and it is then flagged. An unexplained difference is a failure.
 */
export interface VectorSide {
  /** `[x, y]` pairs; integers compare exactly, floats within `tolerance` */
  vector: Array<[string, string]>;
  snapshotId: string;
  watermark: string | null;
  queryHash: string;
}
export interface AgreementReport {
  equal: boolean;
  queryHashEqual: boolean;
  diffs: Array<{ x: string; live: string | null; rebuilt: string | null }>;
  explained: boolean;
  flag: "none" | "different_snapshot" | "different_watermark" | "UNEXPLAINED_DIFFERENCE";
  reason: string | null;
}

const isInt = (v: string): boolean => /^-?\d+$/.test(v);
const same = (a: string, b: string, tol: number): boolean =>
  isInt(a) && isInt(b) ? a === b : Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(a)));

export function compareLiveToRebuild(
  live: VectorSide,
  rebuilt: VectorSide,
  tolerance = 1e-9,
): AgreementReport {
  const lm = new Map(live.vector);
  const rm = new Map(rebuilt.vector);
  const xs = [...new Set([...lm.keys(), ...rm.keys()])].sort();
  const diffs = xs
    .filter((x) => !(lm.has(x) && rm.has(x) && same(lm.get(x)!, rm.get(x)!, tolerance)))
    .map((x) => ({ x, live: lm.get(x) ?? null, rebuilt: rm.get(x) ?? null }));
  const equal = diffs.length === 0;
  const queryHashEqual = live.queryHash === rebuilt.queryHash;
  if (equal) return { equal, queryHashEqual, diffs, explained: true, flag: "none", reason: null };
  if (live.snapshotId !== rebuilt.snapshotId)
    return {
      equal,
      queryHashEqual,
      diffs,
      explained: true,
      flag: "different_snapshot",
      reason: `live ${live.snapshotId} vs rebuilt ${rebuilt.snapshotId}`,
    };
  if (live.watermark !== rebuilt.watermark)
    return {
      equal,
      queryHashEqual,
      diffs,
      explained: true,
      flag: "different_watermark",
      reason: `live ${live.watermark} vs rebuilt ${rebuilt.watermark}`,
    };
  return {
    equal,
    queryHashEqual,
    diffs,
    explained: false,
    flag: "UNEXPLAINED_DIFFERENCE",
    reason: "vectors differ with the same snapshot and watermark",
  };
}
