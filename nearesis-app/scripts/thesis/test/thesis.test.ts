import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBundle, writeBundle } from "../build.ts";
import { fmt, Ledger, scanGrounding, scanSentence } from "../ground.ts";
import { SECTION_TITLES } from "../markdown.ts";
import { parseSections, validateThesisMarkdown } from "../validate.ts";
import { verifyBundle } from "../verify.ts";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "..", "test-fixtures", "thesis");

describe("thesis bundle (fixture raw data, real v3 results)", () => {
  const a = buildBundle({ thesisDir: FIXTURE });
  it("is byte-identical across two builds", () => {
    const b = buildBundle({ thesisDir: FIXTURE });
    expect([...b.files]).toEqual([...a.files]);
    expect(a.thesis.generatedAt).toBe("2026-11-14T00:00:00.000Z");
  });
  it("has the 14 sections in the frozen order and a claim table", () => {
    const md = a.files.get("THESIS.md")!;
    expect(parseSections(md).map(([n]) => n)).toEqual([...SECTION_TITLES]);
    expect(a.thesis.sections.map((s) => s.title)).toEqual([...SECTION_TITLES]);
    expect(a.thesis.claims.length).toBeGreaterThan(10);
    expect(validateThesisMarkdown(md, "INSUFFICIENT_DATA").ok).toBe(true);
  });
  it("reports the frozen verdict and at least 7 charts with queries", () => {
    expect(a.thesis.verdict.status).toBe("INSUFFICIENT_DATA");
    expect(a.thesis.charts.length).toBeGreaterThanOrEqual(7);
    for (const c of a.thesis.charts) {
      expect(c.sentence.length).toBeGreaterThan(10);
      expect(c.sqlExecuted.length).toBeGreaterThan(0);
    }
    expect(a.files.get("site/index.html")).not.toMatch(/https?:\/\//);
  });
  it("fills sentence templates from the data", () => {
    const c = a.thesis.charts.find((x) => x.id === "intents-volume")!;
    expect(c.sentence).toBe(
      "Intents volume went from 1,000 USD on 2026-05-05 to 1,407 USD on 2026-05-16 (40.7% change), with a peak of 1,407 USD on 2026-05-16.",
    );
  });
});

describe("grounding scanner", () => {
  const L = new Ledger(new Map([["r/x.json", { v: 0.0553, s: "n 12" }]]));
  const shown = L.n("r/x.json", "/v");
  it("accepts a cited, read value", () => {
    expect(scanGrounding(`Error was ${shown} [r/x.json#/v]`, L).ok).toBe(true);
  });
  it("catches an ungrounded number, a missing citation and an unknown reference", () => {
    expect(scanGrounding("Error was 0.0554 [r/x.json#/v]", L).violations[0]!.kind).toBe(
      "VALUE_NOT_IN_REFERENCE",
    );
    expect(scanGrounding("Error was 0.0553", L).violations[0]!.kind).toBe("MISSING_CITATION");
    expect(scanGrounding("Error was 0.0553 [r/y.json#/v]", L).violations[0]!.kind).toBe("UNKNOWN_REFERENCE");
    expect(scanSentence("It rose 7%.", ["r/x.json#/v"], L).ok).toBe(false);
  });
  it("exempts dates and hashes, and formats to 3 significant digits", () => {
    expect(scanGrounding("On 2026-05-05 sha " + "a".repeat(64), L).ok).toBe(true);
    expect(fmt(0.0570136397)).toBe("0.0570");
    expect(fmt(1234567.4)).toBe("1,234,567");
  });
  it("rejects causal wording in THESIS.md", () => {
    const md = a2().replace("## Methods\n\n", "## Methods\n\nVolume drives usage. ");
    expect(
      validateThesisMarkdown(md, "INSUFFICIENT_DATA").failures.some((f) => f.rule === "causal_language"),
    ).toBe(true);
  });
});
function a2(): string {
  return buildBundle({ thesisDir: FIXTURE }).files.get("THESIS.md")!;
}

describe("verify", () => {
  it("passes on a clean build and fails when a raw file is tampered with", () => {
    const dir = mkdtempSync(join(tmpdir(), "thesis-test-"));
    cpSync(FIXTURE, dir, { recursive: true });
    writeBundle(buildBundle({ thesisDir: dir }), join(dir, "build"));
    expect(verifyBundle({ thesisDir: dir }).ok).toBe(true);
    const p = join(dir, "raw", "transactions_daily.json");
    writeFileSync(p, readFileSync(p, "utf8").replace("5011", "5012"));
    const r = verifyBundle({ thesisDir: dir });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/manifest sha256/);
  });
  it("fails when an output file is edited", () => {
    const dir = mkdtempSync(join(tmpdir(), "thesis-test-"));
    cpSync(FIXTURE, dir, { recursive: true });
    writeBundle(buildBundle({ thesisDir: dir }), join(dir, "build"));
    const p = join(dir, "build", "THESIS.md");
    writeFileSync(p, readFileSync(p, "utf8") + "\nextra\n");
    expect(verifyBundle({ thesisDir: dir }).ok).toBe(false);
  });
});
