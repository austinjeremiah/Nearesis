/* eslint-disable @typescript-eslint/no-explicit-any */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBundle, writeBundle } from "./build.ts";
import { eachDay, serializeRaw, sha256Hex } from "./data-lib.ts";
import { parseInterpretation, validateInterpretationText } from "./build-forecast.ts";
import { verifyBundle } from "./verify.ts";

type Any = any;
const REAL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "thesis");

function copyThesis(): string {
  const dir = mkdtempSync(join(tmpdir(), "thesis-forecast-"));
  cpSync(join(REAL, "raw"), join(dir, "raw"), { recursive: true });
  cpSync(join(REAL, "sql"), join(dir, "sql"), { recursive: true });
  cpSync(join(REAL, "TABLES.md"), join(dir, "TABLES.md"));
  const ap = "archive/intents-vs-price-v1/build/thesis.json";
  mkdirSync(dirname(join(dir, ap)), { recursive: true });
  cpSync(join(REAL, ap), join(dir, ap));
  return dir;
}
/** TEST fixture only: synthetic fee files in the shape the fee manifest has. */
function addFakeFees(dir: string): void {
  const m = JSON.parse(readFileSync(join(dir, "raw", "manifest.json"), "utf8")) as {
    window: { from: string; to: string };
  };
  const days = eachDay(m.window.from, m.window.to);
  const cols = [
    { name: "d", type: "date" },
    { name: "take_rate_gas_bps", type: "decimal-string|null" },
    { name: "intents_burnt_near", type: "decimal-string|null" },
    { name: "total_burnt_near", type: "decimal-string|null" },
    { name: "spread_bps_stable_to_stable", type: "decimal-string|null" },
  ];
  const rows = days.map((d, i) => [
    d,
    String(1 + (i % 7) * 0.05 + i * 0.002),
    String(100 + i),
    String(5000 + i * 2),
    String(8 + (i % 5) * 0.1),
  ]);
  const text = serializeRaw(cols, rows);
  mkdirSync(join(dir, "raw", "fees"), { recursive: true });
  writeFileSync(join(dir, "raw", "fees", "fees_daily.json"), text);
  const pcols = [
    { name: "account", type: "string" },
    { name: "burnt_near", type: "decimal-string|null" },
  ];
  const ptext = serializeRaw(pcols, [
    ["a.near", "500"],
    ["b.near", "300"],
  ]);
  writeFileSync(join(dir, "raw", "fees", "top_fee_payers.json"), ptext);
  const ds = (id: string, columns: unknown, t: string, n: number) => ({
    id,
    title: id,
    unit: "x",
    file: `raw/fees/${id}.json`,
    sha256: sha256Hex(t),
    rows: n,
    columns,
    source: "test",
    sqlExecuted: null,
    sqlBigQuery: null,
    bigQueryExecuted: false,
    bigQueryBytesBilled: null,
    definition: "TEST fixture",
    caveats: [],
    coverage: { missingDays: [], note: null },
  });
  writeFileSync(
    join(dir, "raw", "fees", "manifest.json"),
    JSON.stringify({
      schema: "nearesis.thesis.raw.v1",
      frozenAt: "2026-11-14T00:00:00.000Z",
      window: m.window,
      datasets: [ds("fees_daily", cols, text, rows.length), ds("top_fee_payers", pcols, ptext, 2)],
    }),
  );
}

describe("forecast bundle without the fee inputs", () => {
  const dir = copyThesis();
  const a = buildBundle({ thesisDir: dir }) as Any;
  it("builds, says what is missing, and is byte-identical across builds", () => {
    const b = buildBundle({ thesisDir: dir });
    expect([...b.files]).toEqual([...a.files]);
    expect([...(b.extra ?? [])]).toEqual([...(a.extra ?? [])]);
    expect(a.thesis.verdict.status).toBe("FORECAST");
    expect(a.thesis.claims[0].verdict).toBe("NOT_COMPUTED");
    expect(a.files.get("THESIS.md") as string).toMatch(/do not exist yet/);
    expect(a.files.get("site/index.html") as string).not.toMatch(/https?:\/\//);
    expect(a.thesis.sections.length).toBe(14);
  });
  it("verifies after writing, and fails when forecast.json is edited", () => {
    writeBundle(a, join(dir, "build"), dir);
    expect(verifyBundle({ thesisDir: dir }).ok).toBe(true);
    const p = join(dir, "raw", "forecast.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"lastDay": "', '"lastDay":  "'));
    expect(verifyBundle({ thesisDir: dir }).ok).toBe(false);
  });
});

describe("forecast bundle with the fee inputs (synthetic TEST files)", () => {
  const dir = copyThesis();
  addFakeFees(dir);
  const a = buildBundle({ thesisDir: dir }) as Any;
  it("picks the fee series up without a code change", () => {
    const ids = a.thesis.forecast.series.map((s: { id: string }) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "take_rate_gas",
        "intents_burn_share",
        "spread_bps_stable",
        "intents_burn_near",
      ]),
    );
    expect(a.thesis.claims[0].id).toBe("claim-take_rate_gas");
    expect(a.thesis.claims[0].verdict).not.toBe("NOT_COMPUTED");
    expect(a.thesis.forecast.derived.toll_split.rows.length).toBe(2);
    expect(a.thesis.forecast.derived.intents_burn_near_12m.usdAtLastClose.priceHeldFixed).toBe(true);
    expect(a.thesis.charts.some((c: { id: string }) => c.id === "top-fee-payers")).toBe(true);
    const c = a.thesis.charts.find((x: { id: string }) => x.id === "forecast-take-rate-gas");
    expect(c.series.map((s: { name: string }) => s.name)).toEqual([
      "history",
      "forecast",
      "band80_lo",
      "band80_hi",
      "band50_lo",
      "band50_hi",
    ]);
  });
});

describe("interpretation.md", () => {
  it("parses ## blocks, ignores comments, and applies the wording rules", () => {
    const m = parseInterpretation(
      "<!-- c -->\n## executive-claim\nText here.\n\n## methods\n\n<!-- only comment -->\n",
    );
    expect([...m.keys()]).toEqual(["executive-claim"]);
    expect(
      validateInterpretationText("Intents will keep growing and we expect more; this is a forecast."),
    ).toEqual([]);
    expect(validateInterpretationText("Volume drives usage.").map((x) => x.rule)).toContain(
      "causal_language",
    );
    expect(validateInterpretationText("This is bullish.").map((x) => x.rule)).toContain("hype_language");
  });
  it("inserts a grounded block as Analysis, and fails the build on an ungrounded number or a causal word", () => {
    const dir = copyThesis();
    const fc = JSON.parse(readFileSync(join(REAL, "raw", "forecast.json"), "utf8")) as {
      series: { tail_signers: { last30: number } };
    };
    const last = Math.round(fc.series.tail_signers.last30 / 1000);
    writeFileSync(
      join(dir, "interpretation.md"),
      `## executive-claim\nLong-tail signers are about ${last} thousand a day and will keep falling [raw/forecast.json#/series/tail_signers/last30].\n`,
    );
    const ok = buildBundle({ thesisDir: dir }) as Any;
    expect(ok.files.get("THESIS.md") as string).toMatch(/\*\*Analysis\*\*[\s\S]*will keep falling/);
    expect(ok.thesis.sections[0].markdown).toMatch(/\*\*Computed\*\*/);
    writeFileSync(
      join(dir, "interpretation.md"),
      `## executive-claim\nSigners are 123456789 [raw/forecast.json#/series/tail_signers/last30].\n`,
    );
    expect(() => buildBundle({ thesisDir: dir })).toThrow(/ungrounded/);
    writeFileSync(
      join(dir, "interpretation.md"),
      `## executive-claim\nNo number here but volume causes usage.\n`,
    );
    expect(() => buildBundle({ thesisDir: dir })).toThrow(/wording/);
    writeFileSync(join(dir, "interpretation.md"), `## nonsense\nx\n`);
    expect(() => buildBundle({ thesisDir: dir })).toThrow(/unknown section/);
    expect(existsSync(join(dir, "build"))).toBe(false);
  });
});
