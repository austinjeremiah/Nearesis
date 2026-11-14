import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  BLOCK_DATE_PREDICATE,
  DELIVERABLES,
  buildPublicationBundle,
  checkBundleInventory,
  checkPublication,
  listVersions,
  sha256Hex,
  treeHashOf,
  verifyBundleHashes,
} from "../../src/index.ts";
import { RESEARCH_BUNDLE, SNAPSHOT, tmp } from "../helpers.ts";

/** Minimal independent PDF reader: pages, text strings and marked-content figures, straight from the bytes. */
function readPdf(buf: Buffer) {
  const t = buf.toString("latin1");
  const pages = (t.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
  const declared = Number(/\/Count\s+(\d+)/.exec(t)?.[1] ?? "0");
  const text: string[] = [];
  for (const m of t.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) text.push(m[1]!.replace(/\\([\\()])/g, "$1"));
  const figures = [...t.matchAll(/\/Figure\s*<<([^>]*)>>\s*BDC([\s\S]*?)EMC/g)].map((m) => ({
    queryId: /\/QueryId\s*\(([^)]*)\)/.exec(m[1]!)?.[1] ?? null,
    alt: /\/Alt\s*\(([^)]*)\)/.exec(m[1]!)?.[1] ?? null,
    drawOps: (m[2]!.match(/\b(re|l)\b/g) ?? []).length,
  }));
  return { pages, declared, text, figures };
}

/** Rejoin wrapped PDF text lines into the paragraphs they were written as. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (
      out.length === 0 ||
      /^(Bull case|Bear case|Falsification|Findings|Finding |Charts? |Chart |SYNTHETIC: |Research memo)/.test(
        l,
      )
    )
      out.push(l);
    else out[out.length - 1] += ` ${l}`;
  }
  return out;
}

/** V16 (16b): publication bundle completeness and one-page memo. FIXTURE. */
it("V16: all 12 deliverable patterns, a one-page memo with 3 linked charts and 3 findings, a verified hash table, and new versions never overwrite", () => {
  const root = tmp("v16-");
  const b1 = buildPublicationBundle({ snapshotDir: SNAPSHOT, researchBundleDir: RESEARCH_BUNDLE, root });
  expect(b1.created).toBe(true);

  // (a) inventory: 12 patterns, each SQL file has a block_date predicate
  expect(DELIVERABLES.length).toBe(12);
  const inv = checkBundleInventory(b1.dir);
  expect(inv.missing).toEqual([]);
  expect(inv.sqlWithoutBlockDate).toEqual([]);
  expect(BLOCK_DATE_PREDICATE.test("SELECT 1 WHERE other = 1")).toBe(false);

  // (b) memo: exactly one page, bull/bear/falsification, 3 charts linked to resolvable queries, 3 findings with intervals
  const pdf = readPdf(readFileSync(join(b1.dir, "MEMO.pdf")));
  expect(pdf.pages).toBe(1);
  expect(pdf.declared).toBe(1);
  const paras = paragraphs(pdf.text);
  const memoText = paras.join("\n");
  expect(memoText).toMatch(/Bull case/);
  expect(memoText).toMatch(/Bear case/);
  expect(memoText).toMatch(/Falsification/);
  expect(pdf.figures.length).toBe(3);
  for (const f of pdf.figures) {
    expect(f.alt?.length ?? 0).toBeGreaterThan(10);
    expect(f.drawOps).toBeGreaterThan(2);
    expect(existsSync(join(b1.dir, "sql", `${f.queryId}.sql`)), `query ${f.queryId}`).toBe(true);
  }
  expect(new Set(pdf.figures.map((f) => f.queryId)).size).toBe(3);
  const findingLines = paras.filter((l) => /^Finding (one|two|three):/.test(l));
  expect(findingLines.length).toBe(3);
  const run = JSON.parse(readFileSync(join(RESEARCH_BUNDLE, "research_run.json"), "utf8")) as {
    estimates: { primary: { delta_mae: number; delta_mae_ci: { lo: number; hi: number } } };
  };
  const p = run.estimates.primary;
  // finding one: number and interval equal the research result artifact
  expect(findingLines[0]).toContain(String(p.delta_mae));
  expect(findingLines[0]).toContain(String(p.delta_mae_ci.lo));
  expect(findingLines[0]).toContain(String(p.delta_mae_ci.hi));
  // every finding carries a number AND an interval (two or more values) and cites result ids
  for (const l of findingLines) {
    expect((l.match(/-?\d+\.\d+|\b\d+\b/g) ?? []).length, l).toBeGreaterThanOrEqual(2);
    expect(l).toMatch(/\[R:[A-Za-z0-9._-]+\]/);
  }
  // (c) hash table verifies; every number in the memo passes the publication (V06) check against the capsule results
  expect(verifyBundleHashes(b1.dir)).toEqual({ ok: true, problems: [] });
  const capsuleResults = b1.memo.findings.flatMap((f) => f.cites);
  expect(capsuleResults.length).toBeGreaterThan(3);
  const metricsMd = readFileSync(join(b1.dir, "METRICS.md"), "utf8");
  const resultRows = [...metricsMd.matchAll(/^\| (.+?) \| (.+?) \| (.*?) \| \[R:(.+?)\] \|$/gm)].map((m) => ({
    id: m[4]!,
    value: m[2]!,
  }));
  expect(resultRows.length).toBeGreaterThan(5);
  const memoCheck = checkPublication(paras.filter((l) => !/^q-/.test(l)).join("\n"), resultRows);
  expect(memoCheck.violations).toEqual([]);
  expect(memoCheck.numbersChecked).toBeGreaterThanOrEqual(6);
  // the hash table notices a change
  const tampered = tmp("v16-t-");
  cpSync(b1.dir, tampered, { recursive: true });
  writeFileSync(join(tampered, "THESIS.md"), `${readFileSync(join(tampered, "THESIS.md"), "utf8")}x`);
  expect(verifyBundleHashes(tampered).ok).toBe(false);
  // the capsule archive is a real zstd tar that contains the capsule manifest
  const arch = readFileSync(join(b1.dir, "research-capsules", `cap-synthetic-2026-11-10.tar.zst`));
  expect(zstdDecompressSync(arch).toString("latin1")).toContain("manifest.json");

  // negative control: deleting EXPERIMENTS.md fails (a)
  const broken = tmp("v16-b-");
  cpSync(b1.dir, broken, { recursive: true });
  rmSync(join(broken, "EXPERIMENTS.md"));
  expect(checkBundleInventory(broken).missing).toEqual(["EXPERIMENTS.md"]);
  expect(verifyBundleHashes(broken).ok).toBe(false);

  // (d) rebuild with changed data creates a new version directory and leaves the previous one byte-unchanged
  const before = treeHashOf(b1.dir);
  const changedSnap = tmp("v16-snap-");
  cpSync(SNAPSHOT, changedSnap, { recursive: true });
  const csvPath = join(changedSnap, "raw", "daily_series.csv");
  const csv = readFileSync(csvPath, "utf8").replace("2026-08-14,13579000,53918", "2026-08-14,13579000,53919");
  writeFileSync(csvPath, csv);
  const desc = JSON.parse(readFileSync(join(changedSnap, "snapshot.json"), "utf8")) as {
    snapshotId: string;
    files: Array<{ sha256: string; bytes: number }>;
  };
  desc.files[0]!.sha256 = sha256Hex(csv);
  desc.files[0]!.bytes = Buffer.byteLength(csv);
  desc.snapshotId = "synthetic-2026-11-11";
  writeFileSync(join(changedSnap, "snapshot.json"), JSON.stringify(desc, null, 2));
  const b2 = buildPublicationBundle({ snapshotDir: changedSnap, researchBundleDir: RESEARCH_BUNDLE, root });
  expect(b2.created).toBe(true);
  expect(b2.version).not.toBe(b1.version);
  expect(listVersions(root)).toEqual([b1.version, b2.version].sort());
  expect(treeHashOf(b1.dir)).toEqual(before);
  // rebuilding unchanged data is a no-op on the existing version
  const b3 = buildPublicationBundle({ snapshotDir: SNAPSHOT, researchBundleDir: RESEARCH_BUNDLE, root });
  expect(b3.created).toBe(false);
  expect(b3.version).toBe(b1.version);
  expect(treeHashOf(b1.dir)).toEqual(before);

  observe({
    testId: "V16",
    observed: `Bundle ${b1.version}: all ${DELIVERABLES.length} deliverable patterns present and non-empty, ${inv.missing.length} missing, every sql file has a block_date predicate. MEMO.pdf: ${pdf.pages} page, bull/bear/falsification text, ${pdf.figures.length} vector charts each with alt text and a QueryId that resolves to sql/<id>.sql, ${findingLines.length} findings each with a number, an interval and result citations (finding one equals research_run estimates.primary delta_mae ${p.delta_mae} and interval ${p.delta_mae_ci.lo} to ${p.delta_mae_ci.hi}). HASHES.json verifies (${verifyBundleHashes(b1.dir).problems.length} problems) and detects a tampered file; ${memoCheck.numbersChecked} memo numbers pass the V06 publication check (Q10 not executed here). Removing EXPERIMENTS.md fails inventory. Changed data created ${b2.version} and left ${b1.version} byte-unchanged (${Object.keys(before).length} files); an unchanged rebuild was a no-op.`,
    fixtureHash: b1.capsuleHash,
    evidence: {
      version: b1.version,
      nextVersion: b2.version,
      files: Object.keys(before).length,
      figures: pdf.figures,
      findings: findingLines,
      memoNumbersChecked: memoCheck.numbersChecked,
    },
  });
}, 300_000);
