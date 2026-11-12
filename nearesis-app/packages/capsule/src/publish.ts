import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildPublicationBundle, verifyBundleHashes } from "./bundle.ts";
import type { BundleOptions, BundleResult } from "./bundle.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.ts";
import { liveQueryId } from "./live.ts";

/**
 * Static publication pipeline (ch.25: "The publisher consumes a signed manifest referencing all completed outputs, not
 * the agent's prose chat"; ch.08: every number resolves to a query, a result and a source snapshot).
 *
 * `publishStatic` builds the bundle (a new immutable version directory), then writes `<version>.publish-manifest.json`
 * NEXT TO it (the bundle's own hash table lists exactly its files, so the manifest cannot live inside). The manifest
 * lists every build artifact with its hash and size, binds the capsule, bundle and snapshot hashes, and carries the
 * lineage of every result: result id -> value -> query id (and the query text's hash) -> source snapshot id and data
 * hash -> the documents and memo findings that cite it. A citation that resolves to no result, a memo number that is
 * not the cited result's value, or a memo chart without a query in the bundle blocks publication. The manifest is
 * signed (ed25519) when a signer is supplied; otherwise it says `unsigned` and verification reports it as such.
 */
/** Thrown when a number, citation or chart in the bundle does not resolve to a query, result and source snapshot. */
export class PublishBlockedError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `publication blocked: ${problems.length} unresolved reference(s): ${problems.slice(0, 3).join("; ")}`,
    );
  }
}

export const PUBLISH_MANIFEST_SCHEMA = "nearesis.publish-manifest.v1";

export interface PublishSigner {
  keyId?: string;
  /** PKCS8 PEM of an ed25519 private key. */
  privateKeyPem: string;
}
export interface PublishOptions extends BundleOptions {
  signer?: PublishSigner;
}

export interface LineageEntry {
  resultId: string;
  label: string;
  value: string;
  unit: string | null;
  computation: string;
  queryId: string;
  querySha256: string;
  /** Every executed query the result derives from (live bundles); `queryId` is the first. Absent for fixtures. */
  queryIds?: string[];
  sourceSnapshotId: string;
  sourceDataHash: string;
  citedIn: string[];
}
export interface PublishManifestBody {
  schemaVersion: typeof PUBLISH_MANIFEST_SCHEMA;
  version: string;
  capsule: {
    capsuleId: string;
    capsuleHash: string;
    resultManifestHash: string;
    preregistrationHash: string | null;
  };
  bundle: { bundleHash: string; fileCount: number };
  snapshot: { snapshotId: string; label: string; dataHash: string };
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  queries: Array<{
    queryId: string;
    path: string;
    sha256: string;
    /** Present for executed queries: where the result went and its hash (must equal the snapshot's raw file hash). */
    execution?: { resultFile: string; resultSha256: string; rows: number; params: { s: string; e: string } };
  }>;
  lineage: LineageEntry[];
  memo: {
    findings: Array<{ number: string; range: [string, string]; cites: string[] }>;
    charts: Array<{ queryId: string; querySha256: string; queryIds?: string[] }>;
  };
}
export interface PublishManifest extends PublishManifestBody {
  manifestHash: string;
  signature:
    { alg: "ed25519"; keyId: string; publicKeyPem: string; value: string } | { alg: "none"; reason: string };
}

const DOCS = ["THESIS.md", "METRICS.md", "EXPERIMENTS.md", "PREREGISTRATION.md", "DATA.md", "LIMITATIONS.md"];

/** The documented query that produces each result family (see the bundle's sql/ files). */
export function queryIdFor(resultId: string): string {
  if (resultId.startsWith("research-")) return "q-research-primary";
  if (resultId === "pearson" || /^lag-\d+-pearson$/.test(resultId)) return "q-lag-correlation";
  return "q-series-daily";
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split("\\").join("/")];
    });
}

const keyIdOf = (publicKeyPem: string): string =>
  sha256Hex(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }) as Buffer).slice(0, 16);

export function buildPublishManifest(b: BundleResult, signer?: PublishSigner): PublishManifest {
  const dir = b.dir;
  const m = b.manifest;
  const hashes = JSON.parse(readFileSync(join(dir, "HASHES.json"), "utf8")) as {
    files: Array<{ path: string; sha256: string; bytes: number }>;
    bundleHash: string;
  };
  const files = listFiles(dir);
  const artifacts = files.map((p) => ({
    path: p,
    sha256: sha256Hex(readFileSync(join(dir, p))),
    bytes: statSync(join(dir, p)).size,
  }));
  const queries = files
    .filter((p) => /^sql\/[^/]+\.sql$/.test(p))
    .map((p) => ({
      queryId: p.slice("sql/".length, -".sql".length),
      path: p,
      sha256: artifacts.find((a) => a.path === p)!.sha256,
    }));
  const queryHash = new Map(queries.map((q) => [q.queryId, q.sha256]));
  // executed queries (live bundles): every query file must be backed by an execution record that matches the snapshot
  const executed = files.includes("sources/queries.json")
    ? (JSON.parse(readFileSync(join(dir, "sources/queries.json"), "utf8")) as {
        queries: Array<{
          queryId: string;
          resultFile: string;
          resultSha256: string;
          rows: number;
          params: { s: string; e: string };
        }>;
        inputs: { series: string[]; research: string[] };
      })
    : null;
  const execOf = new Map((executed?.queries ?? []).map((q) => [q.queryId, q]));
  if (m.label !== "SYNTHETIC")
    for (const q of queries)
      if (!execOf.has(q.queryId))
        throw new PublishBlockedError([
          `query ${q.queryId} has no execution record: a ${m.label} bundle publishes executed queries only`,
        ]);
  const snapFiles = new Map<string, string>(
    (
      JSON.parse(readFileSync(join(dir, "snapshot-manifest.json"), "utf8")) as {
        files: Array<{ path: string; sha256: string }>;
      }
    ).files.map((f) => [f.path, f.sha256]),
  );
  for (const q of executed?.queries ?? [])
    if (snapFiles.get(q.resultFile) !== q.resultSha256)
      throw new PublishBlockedError([
        `query ${q.queryId}: result hash is not the snapshot's ${q.resultFile}`,
      ]);
  const byResult = new Map(m.results.map((r) => [r.id, r]));

  // who cites what: [R:id] markers in the documents, plus the memo findings
  const citedIn = new Map<string, Set<string>>();
  const note = (id: string, file: string) =>
    (citedIn.get(id) ?? citedIn.set(id, new Set()).get(id)!).add(file);
  const unresolved: string[] = [];
  for (const f of DOCS) {
    if (!files.includes(f)) continue;
    for (const c of readFileSync(join(dir, f), "utf8").matchAll(/\[R:([^\]]+)\]/g)) {
      if (!byResult.has(c[1]!)) unresolved.push(`${f}: [R:${c[1]}] resolves to no result`);
      else note(c[1]!, f);
    }
  }
  for (const f of b.memo.findings) {
    for (const id of f.cites) {
      const r = byResult.get(id);
      if (!r) unresolved.push(`MEMO.pdf: finding cites ${id}, which is not a result`);
      else note(id, "MEMO.pdf");
    }
    const vals = new Set(f.cites.map((id) => byResult.get(id)?.value));
    if (!vals.has(f.number))
      unresolved.push(`MEMO.pdf: finding number ${f.number} matches none of its cited results`);
    for (const end of f.range)
      if (!vals.has(end)) unresolved.push(`MEMO.pdf: range end ${end} matches none of its cited results`);
  }
  for (const c of b.memo.charts)
    for (const id of c.queryIds ?? [c.queryId])
      if (!queryHash.has(id)) unresolved.push(`MEMO.pdf: chart query ${id} is not in the bundle`);
  if (unresolved.length) throw new PublishBlockedError(unresolved.slice(0, 20));

  const lineage: LineageEntry[] = m.results.map((r) => {
    const ids = executed
      ? r.id.startsWith("research-")
        ? executed.inputs.research
        : executed.inputs.series
      : [queryIdFor(r.id)];
    const queryId = executed ? liveQueryId(ids[0]!) : ids[0]!;
    const qids = executed ? ids.map(liveQueryId) : null;
    for (const id of qids ?? [queryId])
      if (!queryHash.has(id)) throw new PublishBlockedError([`no query ${id} for result ${r.id}`]);
    const qh = queryHash.get(queryId)!;
    return {
      ...(qids ? { queryIds: qids } : {}),
      resultId: r.id,
      label: r.label,
      value: r.value,
      unit: r.unit,
      computation: r.computation,
      queryId,
      querySha256: qh,
      sourceSnapshotId: m.snapshot.snapshotId,
      sourceDataHash: m.snapshot.dataHash,
      citedIn: [...(citedIn.get(r.id) ?? [])].sort(),
    };
  });
  const body: PublishManifestBody = {
    schemaVersion: PUBLISH_MANIFEST_SCHEMA,
    version: b.version,
    capsule: {
      capsuleId: m.capsuleId,
      capsuleHash: m.capsuleHash,
      resultManifestHash: m.hashes.resultManifestHash,
      preregistrationHash: m.hashes.preregistrationHash,
    },
    bundle: { bundleHash: hashes.bundleHash, fileCount: hashes.files.length + 1 },
    snapshot: {
      snapshotId: m.snapshot.snapshotId,
      label: m.label,
      dataHash: m.snapshot.dataHash,
    },
    artifacts,
    queries: queries.map((q) => {
      const e = execOf.get(q.queryId);
      return e
        ? {
            ...q,
            execution: {
              resultFile: e.resultFile,
              resultSha256: e.resultSha256,
              rows: e.rows,
              params: e.params,
            },
          }
        : q;
    }),
    lineage,
    memo: {
      findings: b.memo.findings.map((f) => ({
        number: f.number,
        range: [f.range[0], f.range[1]],
        cites: f.cites,
      })),
      charts: b.memo.charts.map((c) => ({
        queryId: c.queryId,
        querySha256: queryHash.get(c.queryId)!,
        ...(c.queryIds ? { queryIds: c.queryIds } : {}),
      })),
    },
  };
  const manifestHash = canonicalSha256(body);
  if (!signer)
    return {
      ...body,
      manifestHash,
      signature: { alg: "none", reason: "no signer supplied; this manifest is hash-bound but not signed" },
    };
  const priv = createPrivateKey(signer.privateKeyPem);
  const publicKeyPem = createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  return {
    ...body,
    manifestHash,
    signature: {
      alg: "ed25519",
      keyId: signer.keyId ?? keyIdOf(publicKeyPem),
      publicKeyPem,
      value: edSign(null, Buffer.from(canonicalJson(body)), priv).toString("base64"),
    },
  };
}

export interface PublishResult {
  bundle: BundleResult;
  manifest: PublishManifest;
  manifestPath: string;
}
/** Build the bundle version, then write its signed publish manifest beside it. A version's manifest is written once. */
export function publishStatic(o: PublishOptions): PublishResult {
  const bundle = buildPublicationBundle(o);
  const manifest = buildPublishManifest(bundle, o.signer);
  const manifestPath = `${bundle.dir}.publish-manifest.json`;
  try {
    const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishManifest;
    if (prev.manifestHash !== manifest.manifestHash)
      throw new Error(`version ${bundle.version} was already published with a different manifest`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
  }
  return { bundle, manifest, manifestPath };
}

export interface PublishVerification {
  ok: boolean;
  problems: string[];
  signature: "valid" | "invalid" | "unsigned";
  signerKeyId: string | null;
  /** True only when the signature is valid AND the key id is in `trustedKeyIds`. */
  trusted: boolean;
}

/**
 * Offline verification of a published version: the bundle's own hash table, every artifact against the manifest, the
 * manifest hash and signature, and that every lineage entry still resolves (query file, hash, citations present).
 */
export function verifyPublishManifest(
  versionDir: string,
  manifestPath: string,
  opts: { trustedKeyIds?: string[] } = {},
): PublishVerification {
  const problems: string[] = [];
  let m: PublishManifest;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishManifest;
  } catch {
    return {
      ok: false,
      problems: ["publish manifest unreadable"],
      signature: "unsigned",
      signerKeyId: null,
      trusted: false,
    };
  }
  const hb = verifyBundleHashes(versionDir);
  problems.push(...hb.problems);
  const { manifestHash, signature, ...body } = m;
  if (canonicalSha256(body) !== manifestHash) problems.push("manifestHash does not match the manifest body");
  const actual = new Set(listFiles(versionDir));
  for (const a of m.artifacts) {
    try {
      const b = readFileSync(join(versionDir, a.path));
      if (sha256Hex(b) !== a.sha256 || b.length !== a.bytes) problems.push(`artifact changed: ${a.path}`);
    } catch {
      problems.push(`artifact missing: ${a.path}`);
    }
    actual.delete(a.path);
  }
  for (const extra of actual) problems.push(`artifact not in manifest: ${extra}`);
  const queries = new Map(m.queries.map((q) => [q.queryId, q.sha256]));
  let snapshotFiles = new Map<string, string>();
  try {
    snapshotFiles = new Map(
      (
        JSON.parse(readFileSync(join(versionDir, "snapshot-manifest.json"), "utf8")) as {
          files: Array<{ path: string; sha256: string }>;
        }
      ).files.map((f) => [f.path, f.sha256]),
    );
  } catch {
    problems.push("snapshot-manifest.json unreadable");
  }
  for (const q of m.queries) {
    if (m.snapshot.label !== "SYNTHETIC" && !q.execution)
      problems.push(`query ${q.queryId} was never executed (no execution record)`);
    if (q.execution && snapshotFiles.get(q.execution.resultFile) !== q.execution.resultSha256)
      problems.push(`query ${q.queryId}: result hash is not the source snapshot's ${q.execution.resultFile}`);
  }
  for (const l of m.lineage) {
    for (const id of l.queryIds ?? [])
      if (!queries.has(id)) problems.push(`lineage ${l.resultId}: query ${id} is not in the manifest`);
    if (queries.get(l.queryId) !== l.querySha256)
      problems.push(`lineage ${l.resultId}: query ${l.queryId} hash differs`);
    if (l.sourceSnapshotId !== m.snapshot.snapshotId || l.sourceDataHash !== m.snapshot.dataHash)
      problems.push(`lineage ${l.resultId}: source snapshot differs from the manifest's`);
  }
  for (const c of m.memo.charts) {
    if (queries.get(c.queryId) !== c.querySha256)
      problems.push(`memo chart ${c.queryId}: query hash differs`);
    for (const id of c.queryIds ?? [])
      if (!queries.has(id)) problems.push(`memo chart ${c.queryId}: query ${id} is not in the manifest`);
  }
  let sig: PublishVerification["signature"] = "unsigned";
  let signerKeyId: string | null = null;
  if (signature.alg === "ed25519") {
    signerKeyId = signature.keyId;
    const valid = (() => {
      try {
        return edVerify(
          null,
          Buffer.from(canonicalJson(body)),
          createPublicKey(signature.publicKeyPem),
          Buffer.from(signature.value, "base64"),
        );
      } catch {
        return false;
      }
    })();
    sig = valid ? "valid" : "invalid";
    if (!valid) problems.push("signature does not verify");
  }
  return {
    ok: problems.length === 0,
    problems,
    signature: sig,
    signerKeyId,
    trusted: sig === "valid" && !!signerKeyId && (opts.trustedKeyIds ?? []).includes(signerKeyId),
  };
}
