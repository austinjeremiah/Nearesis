import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CapsuleManifest } from "@nearesis/contracts";
import type { AttestationPolicy, CapsuleViewRecord } from "@nearesis/contracts";
import { verifyAttestation } from "./attestation.ts";
import type { QuoteVerifier } from "./attestation.ts";
import { APP_ROOT, DEFAULT_WASM } from "./build.ts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.ts";
import { SnapshotDescriptor, SnapshotError, deriveVerifierInput } from "./snapshot.ts";
import { computeResults, inputDigest, resultsDigest } from "./verifier-ref.ts";

export type FailureKind =
  | "MANIFEST_INVALID"
  | "RESULT_MANIFEST_HASH_MISMATCH"
  | "SOURCE_SNAPSHOT_HASH_MISMATCH"
  | "CAPSULE_HASH_MISMATCH"
  | "FILE_MISSING"
  | "RAW_HASH_MISMATCH"
  | "FILE_HASH_MISMATCH"
  | "DATA_HASH_MISMATCH"
  | "INPUT_REDERIVATION_MISMATCH"
  | "RESULTS_MISMATCH"
  | "RESEARCH_NOT_REPRODUCIBLE"
  | "WASM_CROSSCHECK_MISMATCH";

export interface VerifyFailure {
  kind: FailureKind;
  detail: string;
}
export interface VerifyOptions {
  /** `reproduce` re-executes fixture research runs offline through uv; `skip` only checks file hashes. */
  research?: "reproduce" | "skip";
  /** `crosscheck` runs the real WASM under a local wasmtime when one is installed. */
  wasm?: "crosscheck" | "skip";
  wasmPath?: string;
  policy?: AttestationPolicy;
  quoteVerifier?: QuoteVerifier;
  /** The attestation job the caller expects; evidence for any other job is rejected. */
  expectedJobId?: string;
  now?: Date;
}
export interface VerifyReport {
  /** Local recomputation only. Never an OutLayer claim. */
  status: "reproduced" | "mismatch";
  reportStatus: "VERIFIED_LOCAL" | "UNVERIFIED";
  failures: VerifyFailure[];
  checks: string[];
  notes: string[];
  checkedAt: string;
  /** The hash chain the verification walked, printed by `research:verify`. Null when the manifest is unreadable. */
  hashChain: Record<string, string | null> | null;
  attestation:
    | { present: false }
    | {
        present: true;
        decision: "accept" | "reject";
        proofLabel: string;
        reasons: string[];
        jobId: string | null;
      };
}

/** Names the schema paths that make a manifest invalid, e.g. `hashes.preregistrationHash`. */
export function manifestProblems(dir: string): string[] {
  try {
    const m = CapsuleManifest.safeParse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    return m.success ? [] : m.error.issues.map((i) => i.path.join(".") || "(root)").slice(0, 10);
  } catch {
    return ["manifest.json"];
  }
}

export function readManifest(dir: string): CapsuleManifest | null {
  try {
    const m = CapsuleManifest.safeParse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    return m.success ? m.data : null;
  } catch {
    return null;
  }
}

/** Environment for child processes: no secrets, no JWTs, only what uv/wasmtime need to run. */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NEARESIS_TOOLCHAIN", "NEARESIS_APP_ROOT"];
  const env: Record<string, string> = {};
  for (const k of Object.keys(process.env))
    if (
      (keep.includes(k) || k.startsWith("UV_") || k.startsWith("COREPACK_")) &&
      process.env[k] !== undefined
    )
      env[k] = process.env[k]!;
  return { ...env, ...extra };
}

export function findWasmtime(): string | null {
  const c = process.env.NEARESIS_WASMTIME;
  if (c && existsSync(c)) return c;
  const r = spawnSync("wasmtime", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? "wasmtime" : null;
}

export async function verifyCapsule(dir: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const checkedAt = (opts.now ?? new Date()).toISOString();
  const failures: VerifyFailure[] = [];
  const checks: string[] = [];
  const notes: string[] = [];
  const fail = (kind: FailureKind, detail: string) => failures.push({ kind, detail });
  let hashChain: Record<string, string | null> | null = null;
  const done = (attestation: VerifyReport["attestation"] = { present: false }): VerifyReport => ({
    status: failures.length ? "mismatch" : "reproduced",
    reportStatus: failures.length ? "UNVERIFIED" : "VERIFIED_LOCAL",
    failures,
    checks,
    notes,
    checkedAt,
    hashChain,
    attestation,
  });

  const m = readManifest(dir);
  if (!m) {
    const bad = manifestProblems(dir);
    fail(
      "MANIFEST_INVALID",
      `manifest.json is missing or does not match the capsule schema: ${bad.join(", ") || "unknown field"}`,
    );
    return done();
  }
  hashChain = {
    capsuleHash: m.capsuleHash,
    sourceSnapshotHash: m.hashes.sourceSnapshotHash,
    semanticModelHash: m.hashes.semanticModelHash,
    inputSha256: m.computation.inputSha256,
    resultsSha256: m.computation.resultsSha256,
    resultManifestHash: m.hashes.resultManifestHash,
    preregistrationHash: m.hashes.preregistrationHash,
    wasmSha256: m.computation.verifier.wasmSha256,
  };
  const { capsuleHash, ...body } = m;
  if (canonicalSha256(body) !== capsuleHash)
    fail("CAPSULE_HASH_MISMATCH", "manifest content does not match capsuleHash");
  else checks.push("capsuleHash");

  if (canonicalSha256(m.results) !== m.hashes.resultManifestHash)
    fail("RESULT_MANIFEST_HASH_MISMATCH", "hashes.resultManifestHash does not equal the hash of the results");
  if (m.hashes.sourceSnapshotHash !== m.snapshot.dataHash)
    fail("SOURCE_SNAPSHOT_HASH_MISMATCH", "hashes.sourceSnapshotHash does not equal snapshot.dataHash");

  const fileChecks: Array<[string, "RAW_HASH_MISMATCH" | "FILE_HASH_MISMATCH"]> = [
    ...m.snapshot.files.map((f) => [f.path, "RAW_HASH_MISMATCH"] as [string, "RAW_HASH_MISMATCH"]),
    ...[
      m.computation.inputFile,
      m.computation.resultsFile,
      ...(m.research ? [m.research.runFile] : []),
      ...m.publication.files,
    ].map((f) => [f.path, "FILE_HASH_MISMATCH"] as [string, "FILE_HASH_MISMATCH"]),
  ];
  const all = [
    ...m.snapshot.files,
    m.computation.inputFile,
    m.computation.resultsFile,
    ...(m.research ? [m.research.runFile] : []),
    ...m.publication.files,
  ];
  for (const [path, kind] of fileChecks) {
    const entry = all.find((f) => f.path === path)!;
    const p = join(dir, path);
    if (!existsSync(p)) {
      fail("FILE_MISSING", path);
      continue;
    }
    const b = readFileSync(p);
    if (sha256Hex(b) !== entry.sha256 || b.length !== entry.bytes)
      fail(kind, `${path} bytes differ from the recorded hash`);
  }
  if (
    !failures.some(
      (f) => f.kind === "RAW_HASH_MISMATCH" || f.kind === "FILE_HASH_MISMATCH" || f.kind === "FILE_MISSING",
    )
  )
    checks.push("fileHashes");

  const dataHash = sha256Hex(
    m.snapshot.files
      .filter((f) => f.path !== "snapshot/snapshot.json")
      .map((f) => `${f.path.replace(/^snapshot\//, "")}:${f.sha256}`)
      .sort()
      .join("\n"),
  );
  if (dataHash !== m.snapshot.dataHash)
    fail("DATA_HASH_MISMATCH", "raw file hashes do not combine to the recorded dataHash");
  else checks.push("dataHash");

  // Recompute from raw bytes, independent of the stored computation files.
  try {
    const desc = SnapshotDescriptor.parse(
      JSON.parse(readFileSync(join(dir, "snapshot", "snapshot.json"), "utf8")),
    );
    const csv = readFileSync(join(dir, "snapshot", desc.series.file));
    const input = deriveVerifierInput(desc, csv);
    const storedInput = readFileSync(join(dir, m.computation.inputFile.path), "utf8");
    if (storedInput !== `${canonicalJson(input)}\n` || inputDigest(input) !== m.computation.inputSha256)
      fail(
        "INPUT_REDERIVATION_MISMATCH",
        "verifier input derived from the raw bytes differs from the stored input",
      );
    else checks.push("inputRederivation");
    const results = computeResults(input);
    const storedResults = readFileSync(join(dir, m.computation.resultsFile.path), "utf8");
    if (
      resultsDigest(results) !== m.computation.resultsSha256 ||
      storedResults !== `${canonicalJson(results)}\n`
    )
      fail("RESULTS_MISMATCH", "recomputed results differ from the recorded results");
    else checks.push("resultsRecomputation");
  } catch (e) {
    fail(
      e instanceof SnapshotError ? "INPUT_REDERIVATION_MISMATCH" : "RESULTS_MISMATCH",
      `recomputation failed: ${(e as Error).message.slice(0, 200)}`,
    );
  }

  if (m.research && (opts.research ?? "reproduce") === "reproduce") {
    if (m.research.reproduce === "fixture") {
      const r = spawnSync(
        "uv",
        ["run", "python", "-m", "nearesis_research.cli", "reproduce", "--dir", join(dir, "research")],
        {
          cwd: APP_ROOT,
          encoding: "utf8",
          env: scrubbedEnv({ PYTHONPATH: join(APP_ROOT, "services", "research"), UV_OFFLINE: "1" }),
          timeout: 240_000,
        },
      );
      if (r.error) notes.push(`research re-execution not run: ${r.error.message.slice(0, 120)}`);
      else if (r.status === 0 && /"reproducible":\s*true/.test(r.stdout)) checks.push("researchReproduction");
      else fail("RESEARCH_NOT_REPRODUCIBLE", `research reproduce exited ${String(r.status)}`);
    } else notes.push("recorded research run: checked by file hash only");
  }

  if ((opts.wasm ?? "crosscheck") === "crosscheck") {
    const wasm = opts.wasmPath ?? DEFAULT_WASM;
    const wt = findWasmtime();
    if (
      existsSync(wasm) &&
      m.computation.verifier.wasmSha256 !== null &&
      sha256Hex(readFileSync(wasm)) !== m.computation.verifier.wasmSha256
    )
      fail(
        "WASM_CROSSCHECK_MISMATCH",
        "local wasm artifact hash differs from the one the capsule was built with",
      );
    else if (!wt || !existsSync(wasm))
      notes.push("wasm cross-check not run: wasmtime or the wasm artifact is unavailable");
    else {
      const r = spawnSync(wt, ["run", "-W", "fuel=1000000000", wasm], {
        input: readFileSync(join(dir, m.computation.inputFile.path)),
        encoding: "utf8",
        env: scrubbedEnv(),
        timeout: 120_000,
      });
      let ok: boolean;
      try {
        const o = JSON.parse(r.stdout) as { status?: string; input_sha256?: string; results_sha256?: string };
        ok =
          o.status === "COMPUTED" &&
          o.input_sha256 === m.computation.inputSha256 &&
          o.results_sha256 === m.computation.resultsSha256;
      } catch {
        ok = false;
      }
      if (ok) checks.push("wasmtimeLocalCrossCheck");
      else fail("WASM_CROSSCHECK_MISMATCH", "wasm output digests differ from the recorded digests");
    }
  }

  // Attestation evidence, if any, goes through the proof policy. Absent evidence is simply "not submitted".
  const evPath = join(dir, "attestation", "evidence.json");
  if (!existsSync(evPath)) return done();
  if (!opts.policy) {
    notes.push("attestation evidence present but no proof policy supplied: treated as unverified");
    return done({
      present: true,
      decision: "reject",
      proofLabel: "none",
      reasons: ["NO_POLICY"],
      jobId: null,
    });
  }
  const ev = JSON.parse(readFileSync(evPath, "utf8")) as { jobId?: string };
  const wasmLocal = m.computation.verifier.wasmSha256 ?? "";
  const d = await verifyAttestation(ev, opts.policy, {
    localWasmSha256: wasmLocal,
    expectedInputSha256: m.computation.inputSha256,
    expectedOutputSha256: m.computation.resultsSha256,
    now: opts.now ?? new Date(),
    ...(opts.quoteVerifier ? { quoteVerifier: opts.quoteVerifier } : {}),
    ...(opts.expectedJobId ? { expectedJobId: opts.expectedJobId } : {}),
  });
  return done({
    present: true,
    decision: d.decision,
    proofLabel: d.proofLabel,
    reasons: d.reasons,
    jobId: typeof ev.jobId === "string" ? ev.jobId : null,
  });
}

/** Build the exact record the capsule viewer renders. Local and OutLayer statuses stay separate. */
export async function loadCapsuleView(
  dir: string,
  opts: VerifyOptions = {},
): Promise<CapsuleViewRecord | null> {
  const m = readManifest(dir);
  if (!m) return null;
  const rep = await verifyCapsule(dir, opts);
  const at = rep.checkedAt;
  const att = rep.attestation;
  const outlayer: CapsuleViewRecord["verification"]["outlayer"] = !att.present
    ? {
        status: "not_submitted",
        method: "OutLayer TEE attestation",
        jobId: null,
        checkedAt: null,
        detail: "No OutLayer job has been submitted for this capsule.",
      }
    : att.proofLabel === "outlayer_attested"
      ? {
          status: "verified",
          method: "OutLayer TEE attestation checked by the proof policy and a quote verifier",
          jobId: att.jobId,
          checkedAt: at,
          detail: "Signer, WASM hash, input and output digests and the TEE quote all passed.",
        }
      : att.decision === "accept"
        ? {
            status: "unverified",
            method:
              att.proofLabel === "fixture_attested"
                ? "Proof policy on fixture evidence (test trust root)"
                : "Proof policy on synthetic evidence",
            jobId: null,
            checkedAt: at,
            detail:
              att.proofLabel === "fixture_attested"
                ? "Fixture evidence, not OutLayer-backed: the quote chained to a test trust root."
                : "Synthetic evidence passed the policy; fixture evidence, not OutLayer-backed.",
          }
        : {
            status: "failed",
            method: "OutLayer TEE attestation",
            jobId: att.jobId,
            checkedAt: at,
            detail: `Rejected: ${att.reasons.join(", ")}`.slice(0, 480),
          };
  const methodParts = ["recomputed from raw bytes with the TypeScript reference verifier (local)"];
  if (rep.checks.includes("researchReproduction")) methodParts.push("research run re-executed offline");
  if (rep.checks.includes("wasmtimeLocalCrossCheck"))
    methodParts.push("WASM re-run under a local wasmtime (local, not OutLayer)");
  const view: CapsuleViewRecord = {
    capsuleId: m.capsuleId,
    title: m.title,
    sourceLabel: m.label,
    createdAt: m.createdAt,
    claims: m.claims,
    results: m.results,
    hashes: m.hashes,
    verification: {
      local: {
        status: rep.status,
        method: methodParts.join("; ").slice(0, 300),
        checkedAt: at,
        detail: (rep.failures.length
          ? `UNVERIFIED: ${rep.failures.map((f) => f.kind).join(", ")}`
          : `Checks passed: ${rep.checks.join(", ")}`
        ).slice(0, 480),
      },
      outlayer,
      failures: rep.failures.slice(0, 50).map((f) => ({ at, kind: f.kind, detail: f.detail.slice(0, 480) })),
    },
    provenance: provenanceOf(m),
    rebuild: {
      command: `pnpm --filter @nearesis/capsule research:rebuild --snapshot <frozen-snapshot-dir> --out <dir>`,
      snapshotId: m.snapshot.snapshotId,
      steps: [
        "Obtain the frozen snapshot directory (snapshot.json and raw files). No credentials are needed.",
        "Run the rebuild command. It verifies the raw hashes, recomputes the metrics and regenerates the exports.",
        "Compare the new manifest.json capsuleHash with this capsule's capsuleHash.",
      ],
    },
    exports: m.publication.files.map((f) => ({
      label: f.path.replace(/^exports\//, ""),
      href: `/v1/capsules/${m.capsuleId}/exports/${f.path.replace(/^exports\//, "")}`,
      sha256: f.sha256,
    })),
    limitations: m.limitations,
  };
  return view;
}

function provenanceOf(m: CapsuleManifest): CapsuleViewRecord["provenance"] {
  const nodes: CapsuleViewRecord["provenance"] = [];
  const rawIds = m.snapshot.files
    .filter((f) => f.path !== "snapshot/snapshot.json")
    .map((f, i) => {
      const id = `src-${i}`;
      nodes.push({ id, kind: "source", label: f.path, hash: f.sha256, parents: [] });
      return id;
    });
  nodes.push({
    id: "snapshot",
    kind: "snapshot",
    label: `Frozen snapshot ${m.snapshot.snapshotId}`,
    hash: m.snapshot.dataHash,
    parents: rawIds,
  });
  nodes.push({
    id: "query",
    kind: "query",
    label: `Verifier input (${m.computation.metrics.join(", ")})`,
    hash: m.computation.inputSha256,
    parents: ["snapshot"],
  });
  nodes.push({
    id: "model",
    kind: "model",
    label: m.computation.verifier.name,
    hash: m.computation.verifier.wasmSha256,
    parents: ["query"],
  });
  nodes.push({
    id: "code",
    kind: "code",
    label: "Analysis code commit",
    hash: m.hashes.analysisCodeCommit,
    parents: [],
  });
  const resultIds: string[] = [];
  for (const r of m.results) {
    const id = `res-${r.id}`;
    resultIds.push(id);
    nodes.push({
      id,
      kind: "result",
      label: r.label.slice(0, 280),
      hash: null,
      parents: [r.id.startsWith("research-") && m.research ? "research" : "model"],
    });
  }
  if (m.research)
    nodes.push({
      id: "research",
      kind: "model",
      label: `Research run (${m.research.reproduce})`,
      hash: m.research.runFile.sha256,
      parents: ["snapshot", "code"],
    });
  for (const c of m.claims)
    nodes.push({
      id: `claim-${c.id}`,
      kind: "claim",
      label: c.text.slice(0, 280),
      hash: null,
      parents: c.resultIds.map((r) => `res-${r}`),
    });
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .map((n) => ({ ...n, parents: n.parents.filter((p) => ids.has(p)) }))
    .filter((n, i, a) => a.findIndex((x) => x.id === n.id) === i);
}
