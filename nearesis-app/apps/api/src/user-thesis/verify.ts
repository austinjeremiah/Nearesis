import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  APP_ROOT,
  canonicalJson,
  computeResults,
  readManifest,
  sha256Hex,
  verifyCapsule,
} from "@nearesis/capsule";
import { readCapsuleFacts } from "./facts.ts";
import { chartData, chartDataSha, coverageOf } from "./generate.ts";
import { evaluateRuleV2, ppmText, RULE_V2_ID } from "./rule.ts";
import { factsPanels, planOf, recordOf, relatednessOfPlan, testNumbers } from "./evaluate.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ProofBinding {
  state: string;
  request_id: string | null;
  tx_hash: string | null;
  input_sha256: string;
  output_sha256: string | null;
  decision: string | null;
}

export interface VerifyDeps {
  /** Capsule directory by id (null when this server does not hold it). */
  capsuleDir(capsuleId: string): string | null;
  /** The OutLayer proof record of the capsule, when the caller (or a published thesis) may read it. */
  proofBinding(capsuleId: string): Promise<ProofBinding | null>;
  wasmPath?: string;
}

export const docHash = (doc: unknown): string => sha256Hex(canonicalJson(doc));

/** Free verification of a workspace thesis: no model call, no chain call. */
export async function verifyWorkspaceThesis(
  doc: Doc,
  storedDocSha256: string,
  capsuleId: string,
  deps: VerifyDeps,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });

  let actual = "";
  try {
    actual = docHash(doc);
  } catch (e) {
    add("documentHash", false, `the stored document cannot be hashed: ${(e as Error).message}`);
  }
  if (actual) {
    add(
      "documentHash",
      actual === storedDocSha256,
      actual === storedDocSha256
        ? `document sha256 ${actual} equals the recorded hash`
        : `document sha256 ${actual} differs from the recorded ${storedDocSha256}`,
    );
  }
  add("schema", doc.schema === "nearesis.thesis.v1", `schema ${String(doc.schema)}`);

  const dir = deps.capsuleDir(capsuleId);
  if (!dir) {
    add("capsule", false, `capsule ${capsuleId} is not available on this server`);
    return checks;
  }
  const manifest = readManifest(dir);
  add(
    "capsuleIdentity",
    !!manifest &&
      manifest.capsuleHash === doc.origin?.capsuleHash &&
      manifest.capsuleId === doc.origin?.capsuleId,
    manifest
      ? manifest.capsuleHash === doc.origin?.capsuleHash
        ? `capsule hash ${manifest.capsuleHash} equals the one the thesis was built from`
        : `capsule hash ${manifest.capsuleHash} differs from the thesis's ${String(doc.origin?.capsuleHash)}`
      : "the capsule manifest is missing or invalid",
  );

  const rep = await verifyCapsule(dir, {
    research: "skip",
    wasm: "crosscheck",
    ...(deps.wasmPath ? { wasmPath: deps.wasmPath } : {}),
  });
  add(
    "capsuleReverification",
    rep.status === "reproduced",
    rep.status === "reproduced"
      ? `reproduced locally (${rep.checks.join(", ")})`
      : `mismatch: ${rep.failures
          .map((f) => `${f.kind}: ${f.detail}`)
          .join("; ")
          .slice(0, 400)}`,
  );

  let facts: ReturnType<typeof readCapsuleFacts> = null;
  try {
    facts = readCapsuleFacts(dir);
  } catch (e) {
    add("capsuleFacts", false, `the capsule's stored results cannot be read: ${(e as Error).message}`);
  }
  if (!facts) {
    if (!checks.some((c) => c.name === "capsuleFacts"))
      add("capsuleFacts", false, "not a workspace-run capsule");
    return checks;
  }

  // every chart's data against the capsule snapshot
  for (const c of (doc.charts ?? []) as Doc[]) {
    const name = `chart:${String(c.id)}`;
    const pe = facts.index.panels.find((p) => p.hash === c.queryHash);
    const panel = pe ? facts.panels.get(pe.hash) : undefined;
    if (!pe || !panel) {
      add(name, false, "the chart's panel is not in the capsule snapshot");
      continue;
    }
    const cd = chartData(panel);
    const fileHash = facts.fileHashes.get(`snapshot/${pe.file}`);
    const dataOk =
      !!cd &&
      chartDataSha(cd) === c.dataSha256 &&
      docHash({ x: c.x, series: (c.series as Doc[]).map((s) => ({ name: s.name, values: s.values })) }) ===
        docHash({ x: cd.x, series: cd.series.map((s) => ({ name: s.name, values: s.values })) });
    const fileOk = fileHash !== undefined && fileHash === c.sha256;
    add(
      name,
      dataOk && fileOk,
      dataOk && fileOk
        ? `data equals the capsule's stored panel result (file sha256 ${c.sha256})`
        : !fileOk
          ? `the chart's file hash ${String(c.sha256)} differs from the capsule's ${String(fileHash)}`
          : "the chart's x or series differ from the capsule's stored panel result",
    );
  }

  // test numbers recomputed from the frozen series
  let recomputed: Record<string, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    recomputed = computeResults(facts.input) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch (e) {
    add("testNumbers", false, `recomputation failed: ${(e as Error).message}`);
  }
  if (recomputed) {
    const t = doc.test ?? {};
    const lag = recomputed.lag_pearson_ppm?.["7"] ?? null;
    const first = (t.lag as Doc[] | undefined)?.[0]?.value ?? null;
    const problems: string[] = [];
    if (String(recomputed.n) !== String(t.n)) problems.push(`n ${String(recomputed.n)} vs ${String(t.n)}`);
    const rp = recomputed.pearson_ppm ?? null;
    if ((rp === null ? null : ppmText(rp)) !== (t.pearson ?? null))
      problems.push(`pearson ${rp === null ? "null" : ppmText(rp)} vs ${String(t.pearson)}`);
    if ((lag === null ? null : ppmText(lag)) !== first)
      problems.push(`lag ${lag === null ? "null" : ppmText(lag)} vs ${String(first)}`);
    if (
      t.window?.from !== facts.input.series.x.points[0]![0] ||
      t.window?.to !== facts.input.series.x.points.at(-1)![0]
    )
      problems.push("window differs");
    if (docHash(recomputed) !== docHash(facts.results))
      problems.push("recomputed results differ from the capsule's results.json");
    add(
      "testNumbers",
      problems.length === 0,
      problems.length === 0
        ? `n, same-day and lag correlations and window recomputed from the frozen series equal the document (n ${String(t.n)})`
        : problems.join("; "),
    );
  }

  // relationship-v2: the numbers the verifier does not attest, recomputed here; v1 documents have none of this
  if (recomputed && doc.test?.rule === RULE_V2_ID) {
    const t = doc.test as Doc;
    const problems: string[] = [];
    const plan = planOf(facts).plan;
    const planKeys = [
      "x",
      "y",
      "relation",
      "lagDays",
      "expectedSign",
      "statement",
      "chosenBy",
      "why",
    ] as const;
    const core = (o: Doc | undefined): unknown => planKeys.map((k) => o?.[k] ?? null);
    if (docHash(core(plan as Doc)) !== docHash(core(t.plan)))
      problems.push("the test plan differs from the capsule's selection record");
    const tn = testNumbers(recomputed, facts.input, plan.lagDays, facts.capsuleHash);
    const rec = recordOf(tn) as Doc;
    for (const k of ["level", "change", "spearman"] as const)
      if ((rec[k]?.value ?? null) !== (t[k]?.value ?? null))
        problems.push(`${k} ${String(rec[k]?.value ?? null)} vs ${String(t[k]?.value ?? null)}`);
    if (docHash(rec.interval ?? null) !== docHash(t.interval ?? null))
      problems.push("bootstrap interval differs");
    const rel = relatednessOfPlan(factsPanels(facts), plan);
    if (rel && (rel.code !== t.relatedness?.code || rel.status !== t.relatedness?.status))
      problems.push(`mechanical-relation check ${rel.code} vs ${String(t.relatedness?.code)}`);
    const window = { from: facts.input.series.x.points[0]![0], to: facts.input.series.x.points.at(-1)![0] };
    const px = facts.panels.get(facts.index.selection.x.panelHash);
    const py = facts.panels.get(facts.index.selection.y.panelHash);
    const cx = px ? coverageOf(px, window).complete : null;
    const cy = py ? coverageOf(py, window).complete : null;
    const verdict = evaluateRuleV2({
      n: tn.pairs,
      levelPpm: tn.levelPpm,
      changePpm: tn.stats.changePpm,
      interval: tn.stats.interval,
      expectedSign: plan.expectedSign,
      coverageComplete: cx === null || cy === null ? null : cx && cy,
      mechanical: (rel?.status ?? "independent") === "mechanical",
    }).status;
    if (verdict !== doc.verdict?.status)
      problems.push(`verdict ${verdict} vs ${String(doc.verdict?.status)}`);
    add(
      "relationshipV2",
      problems.length === 0,
      problems.length === 0
        ? "change, rank and interval numbers, the mechanical-relation check and the verdict recomputed by the API equal the document (these are not part of the verifier's attestation)"
        : problems.join("; "),
    );
  }

  // OutLayer proof state when present
  const ol = doc.verification?.outlayer ?? null;
  const proof = await deps.proofBinding(capsuleId);
  if (!ol) {
    add(
      "outlayerProof",
      true,
      proof
        ? `the document records no proof; a proof now exists in state ${proof.state}`
        : "no OutLayer proof is recorded in the document or for this capsule",
    );
  } else if (!proof) {
    add(
      "outlayerProof",
      false,
      `the document records an OutLayer proof (${String(ol.status)}) that cannot be found for this capsule`,
    );
  } else {
    // The proof records the hash of the job's input file (the verifier input of this capsule); its output hash is the
    // attested raw job output, which is checked by the capsule's own proof routes, not compared here.
    const bound = proof.input_sha256 === facts.inputFileSha256;
    const same = proof.state === ol.status && (ol.requestId ?? null) === (proof.request_id ?? null);
    add(
      "outlayerProof",
      bound && same,
      bound && same
        ? `OutLayer proof ${String(proof.state)} (request ${String(proof.request_id)}) is bound to this capsule's verifier input`
        : !bound
          ? "the OutLayer proof's input hash differs from this capsule's verifier input"
          : `the proof is now ${proof.state}; the document says ${String(ol.status)}`,
    );
  }
  return checks;
}

/** Bundle hash check of the reference thesis: thesis/build/HASHES.json against the files on disk. */
export function verifyReferenceBundle(thesisDir: string): Check[] {
  const checks: Check[] = [];
  const hashesPath = join(thesisDir, "build", "HASHES.json");
  if (!existsSync(hashesPath))
    return [{ name: "bundle", ok: false, detail: "build/HASHES.json is missing; run pnpm thesis:build" }];
  const rec = JSON.parse(readFileSync(hashesPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
    inputs: Array<{ path: string; sha256: string }>;
  };
  const hashOf = (p: string): string | null => {
    // `thesis/...` paths live in the thesis directory; the others (frozen research results) are relative to the app root
    const inThesis = p.startsWith("thesis/") || p.startsWith("build/");
    const base = inThesis ? resolve(thesisDir) : resolve(APP_ROOT);
    const full = resolve(base, p.startsWith("thesis/") ? p.slice("thesis/".length) : p);
    return full.startsWith(base) && existsSync(full)
      ? createHash("sha256").update(readFileSync(full)).digest("hex")
      : null;
  };
  for (const f of rec.files) {
    const h = hashOf(f.path);
    checks.push({
      name: `output:${f.path}`,
      ok: h === f.sha256,
      detail:
        h === null
          ? "file is missing"
          : h === f.sha256
            ? `sha256 ${h}`
            : `sha256 ${h} differs from the recorded ${f.sha256}`,
    });
  }
  for (const i of rec.inputs) {
    const h = hashOf(i.path);
    checks.push({
      name: `input:${i.path}`,
      ok: h === i.sha256,
      detail:
        h === null
          ? "file is missing"
          : h === i.sha256
            ? `sha256 ${h}`
            : `sha256 ${h} differs from the recorded ${i.sha256}`,
    });
  }
  return checks;
}
