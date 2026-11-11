/**
 * pnpm --filter @nearesis/capsule research:rebuild --snapshot <dir> --out <dir> [--research-bundle <dir>] [--expect <manifest.json>]
 * pnpm --filter @nearesis/capsule research:verify --capsule <dir>
 *
 * Rebuild is offline and needs no credentials: it reads only the frozen snapshot directory (plus an optional research
 * bundle), never the network and never a JWT. Exit codes: 0 ok, 3 verification or expectation mismatch, 4 publication
 * blocked, 2 usage.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { APP_ROOT, PublicationBlockedError, buildCapsule } from "./build.ts";
import { SnapshotError } from "./snapshot.ts";
import { verifyCapsule } from "./verify.ts";

const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest,
  options: {
    snapshot: { type: "string" },
    out: { type: "string" },
    capsule: { type: "string" },
    "research-bundle": { type: "string" },
    expect: { type: "string" },
    "no-research": { type: "boolean" },
    "no-wasm": { type: "boolean" },
  },
});
const abs = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

async function main(): Promise<number> {
  if (cmd === "build" || cmd === "rebuild") {
    if (!a.snapshot) {
      console.error(
        "usage: rebuild --snapshot <dir> [--out <dir>] [--research-bundle <dir>] [--expect <manifest.json>]",
      );
      return 2;
    }
    const out = abs(a.out ?? `${APP_ROOT}/.data/capsules/${cmd}-out`);
    let manifest;
    try {
      manifest = buildCapsule({
        snapshotDir: abs(a.snapshot),
        outDir: out,
        ...(a["research-bundle"] ? { researchBundleDir: abs(a["research-bundle"]) } : {}),
      });
    } catch (e) {
      if (e instanceof PublicationBlockedError) {
        console.error(
          JSON.stringify({
            status: "PUBLICATION_BLOCKED",
            file: e.file,
            violations: e.violations.slice(0, 10),
          }),
        );
        return 4;
      }
      if (e instanceof SnapshotError) {
        console.error(JSON.stringify({ status: "SNAPSHOT_REJECTED", kind: e.kind, detail: e.message }));
        return 3;
      }
      throw e;
    }
    const rep = await verifyCapsule(out, {
      research: a["no-research"] || !a["research-bundle"] ? "skip" : "reproduce",
      wasm: a["no-wasm"] ? "skip" : "crosscheck",
    });
    let matches: boolean | null = null;
    if (a.expect) {
      const exp = JSON.parse(readFileSync(abs(a.expect), "utf8")) as { capsuleHash?: string };
      matches = exp.capsuleHash === manifest.capsuleHash;
    }
    console.log(
      JSON.stringify({
        status: rep.status,
        reportStatus: rep.reportStatus,
        capsuleId: manifest.capsuleId,
        capsuleHash: manifest.capsuleHash,
        resultsSha256: manifest.computation.resultsSha256,
        dataHash: manifest.snapshot.dataHash,
        checks: rep.checks,
        notes: rep.notes,
        failures: rep.failures,
        matchesExpected: matches,
        out,
      }),
    );
    return rep.status === "reproduced" && matches !== false ? 0 : 3;
  }
  if (cmd === "verify") {
    if (!a.capsule) {
      console.error("usage: verify --capsule <dir>");
      return 2;
    }
    const rep = await verifyCapsule(abs(a.capsule), { research: a["no-research"] ? "skip" : "reproduce" });
    console.log(JSON.stringify(rep));
    return rep.status === "reproduced" ? 0 : 3;
  }
  console.error("usage: build|rebuild|verify");
  return 2;
}
process.exit(await main());
