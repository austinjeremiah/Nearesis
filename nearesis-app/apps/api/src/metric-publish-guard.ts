import { MetricAuthoringError } from "@nearesis/semantic-gateway";
import type { AuthoringPrincipal, AuthoringService } from "@nearesis/semantic-gateway";
import { KernelError } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";

/** Same shape as an authored or registry metric key (`namespace.name`). Plain research metric names (`m`) are not semantic metrics. */
const SEMANTIC_KEY = /^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,63}$/;

export type PublishAuthoring = Pick<AuthoringService, "assertPublishable" | "pinSnapshot" | "get">;

export const principalOf = (s: Session, workspaceId: string): AuthoringPrincipal => ({
  id: s.userId,
  kind: "human",
  role: s.role,
  tenantId: s.principal.orgId,
  workspaceId,
});

/**
 * Semantic metric references of a capsule manifest. `metricVersions` is `{ key: "N.0.0" }`: for an authored metric the major
 * component is the authored integer version (so `authored.x: "2.0.0"` means `authored.x@2`). Keys that are not semantic
 * metric keys are method labels, not semantic metrics, and are not governed here.
 */
export function capsuleMetricRefs(
  metricVersions: Record<string, string> | undefined,
): Array<{ metricKey: string; version: number }> {
  return Object.entries(metricVersions ?? {})
    .filter(([k]) => SEMANTIC_KEY.test(k))
    .map(([metricKey, v]) => ({ metricKey, version: Number.parseInt(v.split(".")[0] ?? "0", 10) }))
    .filter((r) => Number.isInteger(r.version) && r.version > 0);
}

/**
 * Publication guard: every semantic metric a capsule was computed under must be a CERTIFIED version. A DRAFT, VALIDATED or
 * DEPRECATED metric blocks publication with 422 METRIC_NOT_CERTIFIED (details name each offender). Without an authoring
 * service there is nothing to check and the guard is a no-op. On success the exact certified versions are pinned to
 * `snapshotId` so the publication can be reproduced against the same definitions.
 */
export async function guardCapsuleMetrics(
  authoring: PublishAuthoring | undefined,
  p: AuthoringPrincipal,
  metricVersions: Record<string, string> | undefined,
  snapshotId: string,
): Promise<void> {
  if (!authoring) return;
  const refs = capsuleMetricRefs(metricVersions);
  if (!refs.length) return;
  try {
    await authoring.assertPublishable(p, refs);
    await authoring.pinSnapshot(p, snapshotId, refs);
  } catch (e) {
    if (e instanceof MetricAuthoringError)
      throw new KernelError(e.errorCode, e.reason, e.message, {
        details: e.issues.map((i) => ({ path: i.path, issue: `${i.reason}: ${i.message}` })),
      });
    throw e;
  }
}

/**
 * Pins the certified authored metric versions a time-machine snapshot rests on (`dataVintage.semanticPins`, `key -> version`).
 * A snapshot is always taken (it is history); only CERTIFIED or DEPRECATED authored versions are pinned, a draft stays
 * unpinned and therefore blocks a later publication. Never throws: pinning is a record, not a gate.
 */
export async function pinHistorySnapshot(
  authoring: PublishAuthoring | undefined,
  p: AuthoringPrincipal,
  snapshotId: string,
  semanticPins: Record<string, string>,
): Promise<number> {
  if (!authoring) return 0;
  const refs: Array<{ metricKey: string; version: number }> = [];
  for (const [metricKey, v] of Object.entries(semanticPins)) {
    if (!SEMANTIC_KEY.test(metricKey) || !/^\d+(\.\d+\.\d+)?$/.test(v)) continue;
    const version = Number.parseInt(v, 10);
    try {
      const rec = await authoring.get(p, metricKey, version);
      if ((rec.status === "CERTIFIED" || rec.status === "DEPRECATED") && rec.certifiedAt)
        refs.push({ metricKey, version });
    } catch {
      // not an authored metric (registry metric or unknown): nothing to pin
    }
  }
  if (!refs.length) return 0;
  try {
    await authoring.pinSnapshot(p, snapshotId, refs);
    return refs.length;
  } catch {
    return 0;
  }
}
