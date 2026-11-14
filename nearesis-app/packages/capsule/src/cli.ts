/**
 * pnpm --filter @nearesis/capsule research:rebuild --snapshot <dir> --out <dir> [--research-bundle <dir>] [--expect <manifest.json>]
 * pnpm --filter @nearesis/capsule research:verify --capsule <dir>
 * pnpm --filter @nearesis/capsule research:publish --snapshot <dir> --root <dir> [--research-bundle <dir>] [--key <ed25519.pem>|--keychain]
 * pnpm --filter @nearesis/capsule research:live-input --live-snapshot <docs/research/live-snapshots/id> --out <dir> --commit <analysis-commit>
 * pnpm --filter @nearesis/capsule research:publish-verify --version-dir <dir> [--trusted-key <keyId>]
 *
 * Rebuild is offline and needs no credentials: it reads only the frozen snapshot directory (plus an optional research
 * bundle), never the network and never a JWT. Exit codes: 0 ok, 3 verification or expectation mismatch, 4 publication
 * blocked, 2 usage.
 */
import { readFileSync } from "node:fs";
import { PublishBlockedError, publishStatic, verifyPublishManifest } from "./publish.ts";
import { loadSigningKey } from "./publish-key.ts";
import { registryPathFromEnv } from "./trusted-keys.ts";

/** `--key` is an encrypted PKCS#8 file (passphrase from NEARESIS_PUBLISH_KEY_PASSPHRASE) or, with NEARESIS_ALLOW_PLAIN_PUBLISH_KEY=1, a 0600 plain dev file. */
function loadKeyFlag(path: string): string {
  const encrypted = /ENCRYPTED PRIVATE KEY/.test(readFileSync(path, "utf8"));
  return loadSigningKey(
    encrypted
      ? { kind: "encrypted-file", path }
      : process.env.NEARESIS_ALLOW_PLAIN_PUBLISH_KEY === "1"
        ? { kind: "plain-file", path, allowPlain: true as const }
        : (() => {
            throw new Error(
              "plain key file: set NEARESIS_ALLOW_PLAIN_PUBLISH_KEY=1 (dev fallback) or use --keychain / an encrypted key",
            );
          })(),
  ).privateKeyPem;
}
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { APP_ROOT, PublicationBlockedError, buildCapsule } from "./build.ts";
import { buildLiveCapsuleInput } from "./live.ts";
import { writeCapsuleOwnership } from "./ownership.ts";
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
    org: { type: "string" },
    workspace: { type: "string" },
    "no-research": { type: "boolean" },
    "no-wasm": { type: "boolean" },
    root: { type: "string" },
    key: { type: "string" },
    keychain: { type: "boolean" },
    "version-dir": { type: "string" },
    "live-snapshot": { type: "string" },
    commit: { type: "string" },
    "trusted-key": { type: "string", multiple: true },
  },
});
const abs = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

async function main(): Promise<number> {
  if (cmd === "build" || cmd === "rebuild") {
    if (!a.snapshot) {
      console.error(
        "usage: rebuild --snapshot <dir> [--out <dir>] [--research-bundle <dir>] [--expect <manifest.json>] [--org <uuid> --workspace <uuid>]",
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
    // Tenant ownership (beside the capsule, outside its hash): without it the API treats the capsule as nonexistent.
    if (a.org && a.workspace) writeCapsuleOwnership(out, { orgId: a.org, workspaceId: a.workspace });
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
  if (cmd === "publish") {
    if (!a.snapshot || !a.root) {
      console.error(
        "usage: publish --snapshot <dir> --root <dir> [--research-bundle <dir>] [--key <ed25519-private.pem>]",
      );
      return 2;
    }
    try {
      const r = publishStatic({
        snapshotDir: abs(a.snapshot),
        root: abs(a.root),
        ...(a["research-bundle"] ? { researchBundleDir: abs(a["research-bundle"]) } : {}),
        ...(a.keychain
          ? { signer: { privateKeyPem: loadSigningKey({ kind: "keychain" }).privateKeyPem } }
          : a.key
            ? { signer: { privateKeyPem: loadKeyFlag(abs(a.key)) } }
            : {}),
      });
      const v = verifyPublishManifest(r.bundle.dir, r.manifestPath);
      console.log(
        JSON.stringify({
          status: v.ok ? "published" : "verification_failed",
          version: r.bundle.version,
          created: r.bundle.created,
          capsuleHash: r.bundle.capsuleHash,
          manifestHash: r.manifest.manifestHash,
          signature: v.signature,
          problems: v.problems,
          dir: r.bundle.dir,
          manifest: r.manifestPath,
        }),
      );
      return v.ok ? 0 : 3;
    } catch (e) {
      if (e instanceof PublishBlockedError || e instanceof PublicationBlockedError) {
        console.error(
          JSON.stringify({
            status: "PUBLICATION_BLOCKED",
            detail: e instanceof PublishBlockedError ? e.problems : e.violations.slice(0, 10),
          }),
        );
        return 4;
      }
      throw e;
    }
  }
  if (cmd === "live-input") {
    if (!a["live-snapshot"] || !a.out || !a.commit) {
      console.error("usage: live-input --live-snapshot <dir> --out <dir> --commit <analysis-commit>");
      return 2;
    }
    const r = buildLiveCapsuleInput({
      liveSnapshotDir: abs(a["live-snapshot"]),
      outDir: abs(a.out),
      analysisCodeCommit: a.commit,
    });
    console.log(JSON.stringify({ status: "written", ...r, out: abs(a.out) }));
    return 0;
  }
  if (cmd === "publish-verify") {
    if (!a["version-dir"]) {
      console.error("usage: publish-verify --version-dir <dir> [--trusted-key <keyId>]");
      return 2;
    }
    const dir = abs(a["version-dir"]);
    const v = verifyPublishManifest(dir, `${dir}.publish-manifest.json`, {
      trustedKeyIds: a["trusted-key"] ?? [],
      registry: registryPathFromEnv(),
    });
    console.log(JSON.stringify(v));
    return v.ok ? 0 : 3;
  }
  console.error("usage: build|rebuild|verify|publish|publish-verify");
  return 2;
}
process.exit(await main());
