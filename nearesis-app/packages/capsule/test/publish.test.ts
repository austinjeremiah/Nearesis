import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PublishBlockedError,
  buildPublishManifest,
  publishStatic,
  scrubbedEnv,
  sha256Hex,
  verifyPublishManifest,
} from "../src/index.ts";
import type { PublishManifest } from "../src/index.ts";
import { PKG, RESEARCH_BUNDLE, SNAPSHOT, tmp } from "./helpers.ts";

const key = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
};
const read = (p: string): PublishManifest => JSON.parse(readFileSync(p, "utf8")) as PublishManifest;

describe("static publication pipeline", () => {
  const root = tmp("pub-");
  const pem = key();
  const r = publishStatic({
    snapshotDir: SNAPSHOT,
    researchBundleDir: RESEARCH_BUNDLE,
    root,
    signer: { privateKeyPem: pem },
  });

  it("writes a signed manifest that verifies offline and is trusted only for a pinned key id", () => {
    const v = verifyPublishManifest(r.bundle.dir, r.manifestPath, { trustedKeyIds: [] });
    expect(v.problems).toEqual([]);
    expect(v.signature).toBe("valid");
    expect(v.trusted).toBe(false); // a valid signature from an unpinned key is not trust
    expect(
      verifyPublishManifest(r.bundle.dir, r.manifestPath, { trustedKeyIds: [v.signerKeyId!] }).trusted,
    ).toBe(true);
    expect(
      verifyPublishManifest(r.bundle.dir, r.manifestPath, { trustedKeyIds: ["0".repeat(16)] }).trusted,
    ).toBe(false);
  });

  it("lists every build artifact with its hash and binds capsule, bundle and snapshot", () => {
    const m = read(r.manifestPath);
    const hashes = JSON.parse(readFileSync(join(r.bundle.dir, "HASHES.json"), "utf8")) as {
      bundleHash: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(m.bundle.bundleHash).toBe(hashes.bundleHash);
    expect(m.capsule.capsuleHash).toBe(r.bundle.capsuleHash);
    expect(m.artifacts.map((a) => a.path)).toContain("MEMO.pdf");
    for (const f of hashes.files) expect(m.artifacts.find((a) => a.path === f.path)?.sha256).toBe(f.sha256);
    expect(m.artifacts.find((a) => a.path === "HASHES.json")).toBeTruthy();
    expect(m.snapshot.snapshotId).toBe(r.bundle.manifest.snapshot.snapshotId);
    expect(m.snapshot.dataHash).toBe(r.bundle.manifest.snapshot.dataHash);
  });

  it("every number resolves: result -> query (with the query file's hash) -> source snapshot; memo numbers equal the cited results", () => {
    const m = read(r.manifestPath);
    expect(m.lineage.length).toBe(r.bundle.manifest.results.length);
    for (const l of m.lineage) {
      const q = m.queries.find((x) => x.queryId === l.queryId)!;
      expect(q, l.resultId).toBeTruthy();
      expect(q.sha256).toBe(sha256Hex(readFileSync(join(r.bundle.dir, q.path))));
      expect(l.querySha256).toBe(q.sha256);
      expect(l.sourceSnapshotId).toBe(m.snapshot.snapshotId);
    }
    // the thesis cites results, and each citation is recorded in the lineage
    const cited = new Set(
      [...readFileSync(join(r.bundle.dir, "THESIS.md"), "utf8").matchAll(/\[R:([^\]]+)\]/g)].map(
        (c) => c[1]!,
      ),
    );
    expect(cited.size).toBeGreaterThan(3);
    for (const id of cited) expect(m.lineage.find((l) => l.resultId === id)?.citedIn).toContain("THESIS.md");
    // memo: 3 findings, each number and range end equals a cited result's value; 3 charts with resolvable queries
    expect(m.memo.findings).toHaveLength(3);
    for (const f of m.memo.findings) {
      const vals = new Set(f.cites.map((id) => m.lineage.find((l) => l.resultId === id)!.value));
      expect(vals.has(f.number)).toBe(true);
      for (const e of f.range) expect(vals.has(e)).toBe(true);
      for (const id of f.cites)
        expect(m.lineage.find((l) => l.resultId === id)!.citedIn).toContain("MEMO.pdf");
    }
    expect(m.memo.charts).toHaveLength(3);
    for (const c of m.memo.charts)
      expect(m.queries.find((q) => q.queryId === c.queryId)?.sha256).toBe(c.querySha256);
  });

  it("republishing the same inputs is idempotent; the version and its manifest are never rewritten", () => {
    const again = publishStatic({
      snapshotDir: SNAPSHOT,
      researchBundleDir: RESEARCH_BUNDLE,
      root,
      signer: { privateKeyPem: pem },
    });
    expect(again.bundle.created).toBe(false);
    expect(again.bundle.version).toBe(r.bundle.version);
    // ed25519 signatures are deterministic, so the whole manifest is identical
    expect(again.manifest.manifestHash).toBe(r.manifest.manifestHash);
  });

  it("negative controls: any change to an artifact, the manifest or the signature fails verification", () => {
    const copy = tmp("pub-neg-");
    cpSync(r.bundle.dir, join(copy, "v"), { recursive: true });
    cpSync(r.manifestPath, join(copy, "v.publish-manifest.json"));
    const dir = join(copy, "v");
    const mp = join(copy, "v.publish-manifest.json");
    expect(verifyPublishManifest(dir, mp).ok).toBe(true);

    // an edited document
    writeFileSync(join(dir, "DATA.md"), `${readFileSync(join(dir, "DATA.md"), "utf8")}\nextra`);
    const t1 = verifyPublishManifest(dir, mp);
    expect(t1.ok).toBe(false);
    expect(t1.problems.some((p) => p.includes("DATA.md"))).toBe(true);
    writeFileSync(join(dir, "DATA.md"), readFileSync(join(r.bundle.dir, "DATA.md")));

    // a lineage value changed in the manifest (hash and signature both break)
    const m = read(mp);
    m.lineage[0]!.value = "999";
    writeFileSync(mp, JSON.stringify(m));
    const t2 = verifyPublishManifest(dir, mp);
    expect(t2.ok).toBe(false);
    expect(t2.problems).toContain("manifestHash does not match the manifest body");
    expect(t2.signature).toBe("invalid");

    // a manifest re-signed with a different key still verifies as valid, but is not the pinned key
    cpSync(r.manifestPath, mp);
    const good = verifyPublishManifest(dir, mp);
    const forged = buildPublishManifest(r.bundle, { privateKeyPem: key() });
    writeFileSync(mp, JSON.stringify(forged));
    const t3 = verifyPublishManifest(dir, mp, { trustedKeyIds: [good.signerKeyId!] });
    expect(t3.signature).toBe("valid");
    expect(t3.trusted).toBe(false);

    // an unsigned manifest says so and is never trusted
    const unsigned = buildPublishManifest(r.bundle);
    writeFileSync(mp, JSON.stringify(unsigned));
    const t4 = verifyPublishManifest(dir, mp, { trustedKeyIds: [good.signerKeyId!] });
    expect(t4.ok).toBe(true);
    expect(t4.signature).toBe("unsigned");
    expect(t4.trusted).toBe(false);
  });

  it("blocks publication when a citation, memo number or chart does not resolve", () => {
    // a document cites a result that does not exist
    const copy = tmp("pub-block-");
    cpSync(r.bundle.dir, join(copy, "v"), { recursive: true });
    const dir = join(copy, "v");
    writeFileSync(
      join(dir, "THESIS.md"),
      `${readFileSync(join(dir, "THESIS.md"), "utf8")}\nSee [R:no-such-result].\n`,
    );
    expect(() => buildPublishManifest({ ...r.bundle, dir })).toThrow(PublishBlockedError);
    // a memo finding whose number matches none of its cited results
    const memo = structuredClone(r.bundle.memo);
    memo.findings[0]!.number = "123456.789";
    expect(() => buildPublishManifest({ ...r.bundle, memo })).toThrow(/matches none of its cited results/);
    // a memo chart whose query is not in the bundle
    const memo2 = structuredClone(r.bundle.memo);
    memo2.charts[0]!.queryId = "q-missing";
    expect(() => buildPublishManifest({ ...r.bundle, memo: memo2 })).toThrow(/not in the bundle/);
  });

  it("the CLI publishes and verifies offline in a scrubbed environment with the network blocked, reproducing the same manifest", () => {
    const out = tmp("pub-cli-");
    const env = scrubbedEnv();
    const base = [
      "--import",
      "tsx",
      "--import",
      join(PKG, "src", "no-network.mjs"),
      join(PKG, "src", "cli.ts"),
    ];
    const run = (args: string[]) =>
      spawnSync(process.execPath, [...base, ...args], { cwd: PKG, env, encoding: "utf8", timeout: 280_000 });
    const p = run(["publish", "--snapshot", SNAPSHOT, "--root", out, "--research-bundle", RESEARCH_BUNDLE]);
    expect(p.status, p.stderr.slice(0, 500)).toBe(0);
    const res = JSON.parse(p.stdout) as { status: string; version: string; signature: string; dir: string };
    expect(res.status).toBe("published");
    expect(res.signature).toBe("unsigned"); // no key was given: said, not hidden
    expect(res.version).toBe(r.bundle.version);
    const v = run(["publish-verify", "--version-dir", res.dir]);
    expect(v.status, v.stderr.slice(0, 500)).toBe(0);
    // same inputs, same bytes: only the signature block differs from the signed in-process build
    const cli = read(`${res.dir}.publish-manifest.json`);
    const { signature: _a, manifestHash: _b, ...bodyA } = cli;
    const { signature: _c, manifestHash: _d, ...bodyB } = read(r.manifestPath);
    expect(bodyA).toEqual(bodyB);
  }, 300_000);
});
