/**
 * Rollback procedure (ch.17 "Versioned rollback manifest"). Local, scripted, reversible and offline: "live" is a movable
 * tag (`nearesis-release/<image>:live`) in the local image store; promotion points it at a release's image digests, rollback
 * points it at the previous release's digests named by the rollback manifest. Nothing is pulled or pushed and no database is
 * touched: migrations are expand/contract, so the previous images run on the current schema (the plan refuses otherwise).
 */
import { DIGEST, IMAGE_NAMES, REPO, inspectImage, realRun } from "./images.ts";
import type { ImageName, Run } from "./images.ts";
import { sha256, validateManifest, validateRollback } from "./manifest.ts";
import type { ReleaseManifest, RollbackManifest } from "./manifest.ts";

export const liveTag = (n: ImageName) => `${REPO}/${n}:live`;
export const liveDigests = (run: Run): Record<ImageName, string | null> =>
  Object.fromEntries(IMAGE_NAMES.map((n) => [n, inspectImage(run, liveTag(n))?.id ?? null])) as Record<
    ImageName,
    string | null
  >;

export function promote(
  run: Run,
  images: Record<ImageName, string>,
): { before: Record<ImageName, string | null>; after: Record<ImageName, string | null> } {
  const before = liveDigests(run);
  for (const n of IMAGE_NAMES) {
    if (!inspectImage(run, images[n])) throw new Error(`image ${n} ${images[n]} is not in the local store`);
  }
  for (const n of IMAGE_NAMES) {
    const t = run("docker", ["tag", images[n], liveTag(n)]);
    if (t.code !== 0) throw new Error(`tag ${n} failed`);
  }
  return { before, after: liveDigests(run) };
}

export interface RollbackPlan {
  ok: boolean;
  problems: string[];
  from: Record<ImageName, string | null>;
  to: Record<ImageName, string> | null;
  previousGitSha: string | null;
  migration: RollbackManifest["migrationCompatibility"];
}

/** Verifies everything BEFORE moving anything: manifest validity and binding, digests present locally, expand/contract. */
export function planRollback(run: Run, current: ReleaseManifest, rb: RollbackManifest): RollbackPlan {
  const problems: string[] = [];
  for (const p of validateManifest({ ...current })) problems.push(`manifest.${p.field}: ${p.problem}`);
  for (const p of validateRollback(rb, current)) problems.push(`${p.field}: ${p.problem}`);
  const to = {} as Record<ImageName, string>;
  for (const n of IMAGE_NAMES) {
    const d = rb.previousImages[n];
    if (!d || !DIGEST.test(d)) continue;
    to[n] = d;
    const info = inspectImage(run, d);
    if (!info) problems.push(`previous image ${n} ${d.slice(0, 19)} is not in the local store`);
    else if (
      rb.previousGitSha &&
      info.labels["org.nearesis.git-sha"] &&
      info.labels["org.nearesis.git-sha"] !== rb.previousGitSha
    )
      problems.push(
        `previous image ${n} was built from ${info.labels["org.nearesis.git-sha"]}, not ${rb.previousGitSha}`,
      );
  }
  return {
    ok: problems.length === 0,
    problems,
    from: liveDigests(run),
    to: IMAGE_NAMES.every((n) => to[n]) ? to : null,
    previousGitSha: rb.previousGitSha,
    migration: rb.migrationCompatibility,
  };
}

export interface RollbackResult {
  applied: boolean;
  dryRun: boolean;
  plan: RollbackPlan;
  after: Record<ImageName, string | null> | null;
  verified: boolean;
  /** Pointer file for undoing the rollback: the digests that were live before. */
  undo: Record<ImageName, string | null> | null;
}

export function rollback(opts: {
  run?: Run;
  current: ReleaseManifest;
  rollback: RollbackManifest;
  dryRun?: boolean;
}): RollbackResult {
  const run = opts.run ?? realRun;
  const plan = planRollback(run, opts.current, opts.rollback);
  if (!plan.ok || !plan.to)
    return { applied: false, dryRun: !!opts.dryRun, plan, after: null, verified: false, undo: null };
  if (opts.dryRun) return { applied: false, dryRun: true, plan, after: null, verified: false, undo: null };
  const { before, after } = promote(run, plan.to);
  const verified =
    IMAGE_NAMES.every((n) => after[n] === plan.to![n]) && verifyLive(run, plan.previousGitSha).ok;
  return { applied: true, dryRun: false, plan, after, verified, undo: before };
}

/** The live tags must resolve to images built from `gitSha` and run as a non-root user. */
export function verifyLive(run: Run, gitSha: string | null): { ok: boolean; detail: string[] } {
  const detail: string[] = [];
  for (const n of IMAGE_NAMES) {
    const i = inspectImage(run, liveTag(n));
    if (!i) detail.push(`${n}: live tag missing`);
    else {
      if (gitSha && i.labels["org.nearesis.git-sha"] !== gitSha)
        detail.push(`${n}: built from ${i.labels["org.nearesis.git-sha"] ?? "unknown"}`);
      if (!/^[1-9]/.test(i.user)) detail.push(`${n}: runs as root`);
    }
  }
  return { ok: detail.length === 0, detail };
}
export const manifestDigest = (m: ReleaseManifest) => sha256(JSON.stringify(m));
