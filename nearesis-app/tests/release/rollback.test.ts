/**
 * Rollback procedure tests. The logic runs against an in-memory image store (every run); the same procedure runs against the
 * locally built images (`.data/release/candidate` and `.data/release/previous`) when they exist: promote the candidate,
 * dry-run the rollback, roll back, verify the live tags and start a container from the rolled-back api image.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../scripts/release/manifest.ts";
import type { ReleaseManifest, RollbackManifest } from "../../scripts/release/manifest.ts";
import { IMAGE_NAMES, readBuildRecord, realRun } from "../../scripts/release/images.ts";
import type { ImageName, Run } from "../../scripts/release/images.ts";
import { liveDigests, liveTag, promote, rollback, verifyLive } from "../../scripts/release/rollback.ts";

const d = (c: string) => `sha256:${c.repeat(64)}`;
const SHA_CUR = "c".repeat(40);
const SHA_PREV = "b".repeat(40);

/** Minimal docker emulation: images by id and tag, `docker image inspect` and `docker tag`. */
function fakeDocker(images: Record<string, { sha: string }>): {
  run: Run;
  tags: Map<string, string>;
  calls: string[][];
} {
  const tags = new Map<string, string>();
  const calls: string[][] = [];
  const run: Run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[2]!;
      const id = images[ref] ? ref : tags.get(ref);
      if (!id || !images[id]) return { code: 1, out: "", err: "no such image" };
      return {
        code: 0,
        out: JSON.stringify({
          Id: id,
          Size: 1,
          Config: { User: "10001:10001", Labels: { "org.nearesis.git-sha": images[id]!.sha } },
        }),
        err: "",
      };
    }
    if (args[0] === "tag") {
      tags.set(args[2]!, args[1]!);
      return { code: 0, out: "", err: "" };
    }
    return { code: 1, out: "", err: "unsupported" };
  };
  return { run, tags, calls };
}
const store = () => ({
  [d("a")]: { sha: SHA_CUR },
  [d("b")]: { sha: SHA_CUR },
  [d("c")]: { sha: SHA_CUR },
  [d("d")]: { sha: SHA_CUR },
  [d("1")]: { sha: SHA_PREV },
  [d("2")]: { sha: SHA_PREV },
  [d("3")]: { sha: SHA_PREV },
  [d("4")]: { sha: SHA_PREV },
});
const CUR = { api: d("a"), worker: d("b"), web: d("c"), sandbox: d("d") };
const PREV = { api: d("1"), worker: d("2"), web: d("3"), sandbox: d("4") };

function manifests(over: { prev?: typeof PREV | null } = {}): { m: ReleaseManifest; rb: RollbackManifest } {
  const { manifest, rollback: rb } = buildManifest({
    root: join(import.meta.dirname, "..", ".."),
    gitSha: SHA_CUR,
    images: CUR,
    testnetTxHash: "TestnetTx1111111111111111111111111111111111",
    approver: "fixture-owner-test-principal",
    expectedMaxSpend: "0.05 NEAR",
    previous: over.prev === null ? null : { gitSha: SHA_PREV, images: over.prev ?? PREV },
  });
  return { m: manifest, rb };
}

describe("rollback against an in-memory image store", () => {
  it("dry run changes nothing; a real rollback moves every live tag to the previous digests and verifies the previous git sha", () => {
    const fd = fakeDocker(store());
    promote(fd.run, CUR);
    expect(liveDigests(fd.run)).toEqual(CUR);
    const { m, rb } = manifests();
    const dry = rollback({ run: fd.run, current: m, rollback: rb, dryRun: true });
    expect(dry.plan.problems).toEqual([]);
    expect(dry.plan.ok).toBe(true);
    expect(dry.applied).toBe(false);
    expect(liveDigests(fd.run)).toEqual(CUR);
    const done = rollback({ run: fd.run, current: m, rollback: rb });
    expect(done.applied).toBe(true);
    expect(done.verified).toBe(true);
    expect(done.after).toEqual(PREV);
    expect(done.undo).toEqual(CUR);
    expect(verifyLive(fd.run, SHA_PREV).ok).toBe(true);
    // the rollback is itself reversible with the recorded undo pointer
    promote(fd.run, done.undo as Record<ImageName, string>);
    expect(liveDigests(fd.run)).toEqual(CUR);
  });

  it("refuses, moving nothing, when the previous image is absent, the rollback manifest is tampered with, migrations are destructive or the previous release is unknown", () => {
    const fd = fakeDocker(store());
    promote(fd.run, CUR);
    const { m, rb } = manifests();

    const absent = rollback({
      run: fakeDocker({ [d("a")]: { sha: SHA_CUR }, [d("b")]: { sha: SHA_CUR }, [d("c")]: { sha: SHA_CUR } })
        .run,
      current: m,
      rollback: rb,
    });
    expect(absent.applied).toBe(false);
    expect(absent.plan.problems.join("\n")).toMatch(/not in the local store/);

    const tampered = rollback({
      run: fd.run,
      current: m,
      rollback: { ...rb, previousGitSha: "e".repeat(40) },
    });
    expect(tampered.applied).toBe(false);
    expect(tampered.plan.problems.join("\n")).toMatch(/rollbackManifestSha/);

    const destructive: RollbackManifest = {
      ...rb,
      migrationCompatibility: { ...rb.migrationCompatibility, destructive: ["x.sql: drop table"] },
    };
    const dres = rollback({
      run: fd.run,
      current: { ...m, rollbackManifestSha: m.rollbackManifestSha },
      rollback: destructive,
    });
    expect(dres.applied).toBe(false);
    expect(dres.plan.problems.join("\n")).toMatch(/destructive migrations/);

    const none = manifests({ prev: null });
    const nres = rollback({ run: fd.run, current: none.m, rollback: none.rb });
    expect(nres.applied).toBe(false);
    expect(nres.plan.problems.join("\n")).toMatch(/previousGitSha|missing digest/);

    const wrongSha = fakeDocker({ ...store(), [d("1")]: { sha: "f".repeat(40) } });
    promote(wrongSha.run, CUR);
    const wres = rollback({ run: wrongSha.run, current: m, rollback: rb });
    expect(wres.applied).toBe(false);
    expect(wres.plan.problems.join("\n")).toMatch(/was built from/);

    expect(liveDigests(fd.run)).toEqual(CUR);
    expect(fd.calls.filter((c) => c[1] === "tag").length).toBe(4); // only the initial promote
  });
});

const REL = join(import.meta.dirname, "..", "..", ".data", "release");
const cand = readBuildRecord(join(REL, "candidate"));
const prev = readBuildRecord(join(REL, "previous"));
const haveDocker = realRun("docker", ["version"]).code === 0;

describe.skipIf(!cand || !prev || !haveDocker)("rollback against the locally built images", () => {
  it("promotes the candidate, then rolls back to the previous build and runs the rolled-back image", () => {
    const toMap = (r: NonNullable<typeof cand>) =>
      Object.fromEntries(IMAGE_NAMES.map((n) => [n, r.images[n].digest])) as Record<ImageName, string>;
    const { m, rb } = (() => {
      const b = buildManifest({
        root: join(import.meta.dirname, "..", ".."),
        gitSha: cand!.gitSha,
        images: toMap(cand!),
        testnetTxHash: "TestnetTx1111111111111111111111111111111111",
        approver: "fixture-owner-test-principal",
        expectedMaxSpend: "0.05 NEAR",
        previous: { gitSha: prev!.gitSha, images: toMap(prev!) },
      });
      return { m: b.manifest, rb: b.rollback };
    })();
    promote(realRun, toMap(cand!));
    expect(liveDigests(realRun)).toEqual(toMap(cand!));
    expect(verifyLive(realRun, cand!.gitSha).ok).toBe(true);

    const dry = rollback({ current: m, rollback: rb, dryRun: true });
    expect(dry.plan.problems).toEqual([]);
    expect(liveDigests(realRun)).toEqual(toMap(cand!));

    const done = rollback({ current: m, rollback: rb });
    expect(done.applied && done.verified).toBe(true);
    expect(liveDigests(realRun)).toEqual(toMap(prev!));
    const ran = realRun("docker", [
      "run",
      "--rm",
      liveTag("api"),
      "-e",
      "console.log(process.version, process.getuid())",
    ]);
    expect(ran.out.trim()).toMatch(/^v24\.\d+\.\d+ 10001$/);
    // leave the candidate live
    promote(realRun, toMap(cand!));
  }, 120_000);
});
