import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NotCapsulable,
  buildWorkspaceRunCapsule,
  checkPublication,
  computeResults,
  inputDigest,
  pickSeries,
  readManifest,
  resultsDigest,
  scaleDecimal,
  validateInput,
  verifyCapsule,
  workspaceRunCapsuleId,
} from "../src/index.ts";
import type { RunFinding, RunPanel, VerifierInput, WorkspaceRunInput } from "../src/index.ts";
import { tmp } from "./helpers.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const day = (i: number, base = "2026-10-01"): string =>
  new Date(Date.parse(`${base}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

/** An analytics-shaped panel body as `GET /v1/workspaces/:id/panels/:hash/data` returns it. */
const panel = (hash: string, title: string, columns: string[], rows: unknown[][]): RunPanel => ({
  hash,
  title,
  body: {
    workspaceId: WS,
    kind: "analytics",
    queryHash: hash,
    state: "complete",
    chart: {
      queryHash: hash,
      columns: columns.map((name) => ({ name, unit: name === "period" ? null : "unit" })),
      rows,
    },
    provenance: {
      sources: ["nearesis_live.intents_swaps"],
      semanticVersion: "intents-1.0.0",
      sourceLabel: "ANALYTICS",
    },
    coverage: { state: "complete" },
    caveats: [],
  },
});
const swaps = Array.from({ length: 12 }, (_, i) => [day(i), 100 + i * 3 + (i % 4)]);
const volume = Array.from({ length: 12 }, (_, i) => [
  day(i),
  `${5000 + i * 40 + (i % 3)}.${String(25 + i).padStart(2, "0")}`,
]);
const P1 = panel(
  H1,
  "Daily swaps",
  ["period", "swaps", "volumeUsd"],
  swaps.map((r, i) => [r[0], r[1], volume[i]![1]]),
);
const P2 = panel(
  H2,
  "Refund rate",
  ["period", "refundRate"],
  swaps.map((r, i) => [r[0], i % 5 === 0 ? 0.01 : (0.02 + i * 0.001).toFixed(3)]),
);

const finding = (statement: string, facts: RunFinding["facts"]): RunFinding => ({
  id: "33333333-3333-4333-8333-333333333333",
  status: "supported",
  basis: "observation",
  kind: "change",
  statement,
  facts,
});
const fact = (value: string, rowId: string): RunFinding["facts"][number] => ({
  value,
  unit: "swaps",
  resultRef: { column: "swaps", rowIds: [rowId], queryHash: H1 },
});
const input = (o: Partial<WorkspaceRunInput> = {}): WorkspaceRunInput => ({
  workspaceId: WS,
  runId: RUN,
  source: "live",
  frozenAt: "2026-11-13T04:00:00.000Z",
  question: "How did swaps change",
  panels: [P1, P2],
  findings: [finding("Daily swaps rose from 100 to 133.", [fact("100", day(0)), fact("133", day(11))])],
  ...o,
});

describe("series rule", () => {
  it("picks the first pair with the longest shared consecutive run, in panel and column order", () => {
    const s = pickSeries([P1, P2]);
    expect(s.x.column).toBe("swaps");
    expect(s.y.column).toBe("volumeUsd");
    expect(s.days).toHaveLength(12);
    expect(s.truncatedToLatest).toBe(false);
  });

  it("shrinks to the longest fully consecutive run where both series have values (nothing filled)", () => {
    // swaps misses day 5; refund misses day 9: the shared runs are days 0-4 (5), 6-8 (3), 10-11 (2)
    const a = panel(
      "c".repeat(64),
      "A",
      ["period", "swaps"],
      swaps.filter((_, i) => i !== 5),
    );
    const b = panel(
      "d".repeat(64),
      "B",
      ["period", "rate"],
      swaps.map((r, i) => [r[0], i === 9 ? null : 0.1 + i * 0.01]),
    );
    const s = pickSeries([a, b]);
    expect(s.days.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10))).toEqual(
      [0, 1, 2, 3, 4].map((i) => day(i)),
    );
  });

  it("skips a panel with several rows per day and a pair with identical values", () => {
    const multi = panel(
      "e".repeat(64),
      "M",
      ["period", "v"],
      [
        [day(0), 1],
        [day(0), 2],
        [day(1), 3],
      ],
    );
    const same = panel("f".repeat(64), "S", ["period", "swaps2"], swaps);
    expect(() => pickSeries([multi])).toThrow(NotCapsulable);
    const one = panel("9".repeat(64), "O", ["period", "swaps"], swaps);
    expect(() => pickSeries([one, same])).toThrow(/share at least two/);
  });

  it("reads ISO-midnight day cells (semantic panels) as days", () => {
    const sem = panel(
      "8".repeat(64),
      "Sem",
      ["day", "m"],
      swaps.map((r) => [`${r[0]}T00:00:00.000Z`, r[1]]),
    );
    expect(pickSeries([sem, P2]).days).toHaveLength(12);
  });
});

describe("exact scaling", () => {
  it("scales decimals to integers with no floating point", () => {
    expect(scaleDecimal("0.005065", 6)).toBe(5065n);
    expect(scaleDecimal("-12.5", 3)).toBe(-12500n);
    expect(scaleDecimal("123456789012.123456", 6)).toBe(123456789012123456n);
    expect(scaleDecimal("7", 2)).toBe(700n);
  });

  it("states the scale in the unit and keeps every decimal digit", () => {
    const out = tmp("wsrun-");
    const { build } = buildWorkspaceRunCapsule(input(), join(out, "cap"));
    expect(build.selection.y.unit).toBe("unit_x1e2");
    expect(build.selection.x.unit).toBe("unit");
    const vi = JSON.parse(
      readFileSync(join(out, "cap", "computation", "verifier-input.json"), "utf8"),
    ) as VerifierInput;
    expect(vi.series.y.points[0]).toEqual([day(0), "500025"]);
    expect(vi.series.y.points[11]![1]).toBe(String(5000 + 11 * 40 + (11 % 3)) + String(25 + 11));
    expect(vi.series.x.points[0]).toEqual([day(0), "100"]);
  });

  it("converts JSON numbers printed with an exponent exactly", () => {
    const tiny = panel(
      "7".repeat(64),
      "T",
      ["period", "r"],
      swaps.map((r, i) => [r[0], Number(`${i === 3 ? 1 : 2 + i}e-7`)]),
    );
    const out = tmp("wsrun-");
    buildWorkspaceRunCapsule(
      input({ panels: [tiny, P2], findings: [finding("No numbers here.", [])] }),
      join(out, "cap"),
    );
    const vi = JSON.parse(
      readFileSync(join(out, "cap", "computation", "verifier-input.json"), "utf8"),
    ) as VerifierInput;
    const y = vi.series.x;
    expect(y.points[3]![1]).toBe("1");
    expect(y.points[0]![1]).toBe("2");
  });

  it("refuses a value above 1e15 after scaling instead of rounding", () => {
    const big = panel(
      "6".repeat(64),
      "Big",
      ["period", "b"],
      swaps.map((r, i) => [r[0], i === 0 ? "1000000000000000.5" : "3"]),
    );
    const out = tmp("wsrun-");
    expect(() => buildWorkspaceRunCapsule(input({ panels: [big, P2] }), join(out, "cap"))).toThrow(
      /above 1e15/,
    );
  });
});

describe("explicit pair, rounding and hash stability", () => {
  it("a capsule chosen by the original rule with exact integer scaling keeps exactly the hash it always had", () => {
    const ints = Array.from({ length: 12 }, (_, i) => [
      day(i),
      100 + i * 3 + (i % 4),
      50 + ((i * 5) % 7) * 11 + i,
    ]);
    const PI = panel(H1, "Daily swaps", ["period", "swaps", "txs"], ints);
    const m = buildWorkspaceRunCapsule(input({ panels: [PI] }), join(tmp("wsrun-"), "cap")).manifest;
    // pinned from the builder before explicit pairs, rounding and the verifier-safe unit text existed
    expect(m.capsuleHash).toBe("78e80c96dde6b33d87bb1e87a325c5042f4c327690515962cd1d68ded1809941");
    expect(m.capsuleId).toBe(workspaceRunCapsuleId(WS, RUN));
  });
  it("scaled units are ids the pinned WASM verifier accepts (letters, digits and . _ : - / only, at most 32)", () => {
    const { build } = buildWorkspaceRunCapsule(input(), join(tmp("wsrun-"), "cap"));
    expect(build.selection.y.unit).toMatch(/^[A-Za-z0-9._:/-]{1,32}$/);
    expect(build.selection.x.unit).toMatch(/^[A-Za-z0-9._:/-]{1,32}$/);
  });
  it("an explicit pair is used instead of the rule, recorded with who chose it, and is a different capsule", () => {
    const test = {
      x: { panelHash: H2, column: "refundRate" },
      y: { panelHash: H1, column: "swaps" },
      expectedSign: "negative" as const,
      chosenBy: "user" as const,
    };
    const out = tmp("wsrun-");
    const dir = join(out, "cap");
    const { manifest, build } = buildWorkspaceRunCapsule(input({ test }), dir);
    expect(build.selection.x.column).toBe("refundRate");
    expect(build.selection.y.column).toBe("swaps");
    expect(manifest.capsuleId).toBe(workspaceRunCapsuleId(WS, RUN, test));
    expect(manifest.capsuleId).not.toBe(workspaceRunCapsuleId(WS, RUN));
    const rec = JSON.parse(readFileSync(join(dir, "snapshot", "raw", "run-panels.json"), "utf8"));
    expect(rec.selection).toMatchObject({
      chosenBy: "user",
      namedForQuestion: true,
      plan: {
        chosenBy: "user",
        expectedSign: "negative",
        relation: "moves_with",
        statement: "Days with higher refund rate have lower swaps.",
      },
    });
    expect(workspaceRunCapsuleId(WS, RUN, { ...test, expectedSign: "positive" })).not.toBe(
      manifest.capsuleId,
    );
    expect(() =>
      buildWorkspaceRunCapsule(
        input({ test: { ...test, x: { panelHash: H2, column: "nope" } } }),
        join(tmp("wsrun-"), "cap"),
      ),
    ).toThrow(/TEST_PAIR_NOT_FOUND/);
  });
  it("a NEAR price with many decimals now builds: rounded half-even to six decimals, recorded per series in the selection", () => {
    const price = panel(
      "c".repeat(64),
      "Price",
      ["period", "priceUsd"],
      swaps.map((r, i) => [r[0], `${(3 + (i % 7) / 10).toFixed(1)}1234567890123456${i % 10}`]),
    );
    const out = tmp("wsrun-");
    const dir = join(out, "cap");
    const { build } = buildWorkspaceRunCapsule(
      input({
        panels: [P1, price],
        test: { x: { panelHash: H1, column: "swaps" }, y: { panelHash: "c".repeat(64), column: "priceUsd" } },
      }),
      dir,
    );
    expect(build.selection.y.unit).toMatch(/^[A-Za-z0-9._:/-]{1,32}$/);
    const rec = JSON.parse(readFileSync(join(dir, "snapshot", "raw", "run-panels.json"), "utf8"));
    expect(rec.selection.rounding.y).toMatchObject({ decimalsKept: 6 });
    expect(rec.selection.rounding.y.maxAbsRoundingDifference).toMatch(/^0\.000000\d+$/);
    expect(rec.selection.rounding.x).toBeUndefined();
    const csv = readFileSync(join(dir, "snapshot", "raw", "daily_series.csv"), "utf8").split("\n")[1]!;
    expect(csv.split(",")[2]).toBe("3012346");
  });
});

describe("workspace run capsule", () => {
  it("is a real capsule: verifies locally, matches the reference verifier, grounded notes pass the publication check", async () => {
    const out = tmp("wsrun-");
    const dir = join(out, "cap");
    const { manifest, build } = buildWorkspaceRunCapsule(input(), dir);
    expect(manifest.capsuleId).toBe(workspaceRunCapsuleId(WS, RUN));
    expect(manifest.capsuleId).toMatch(/^cap-wsrun-[a-p]{16}$/);
    expect(manifest.label).toBe("LIVE");
    expect(readManifest(dir)!.capsuleHash).toBe(manifest.capsuleHash);
    expect(build.selection.metrics).toEqual(["lag_pearson:7", "pearson", "summary"]);

    const rep = await verifyCapsule(dir, { research: "skip", wasm: "skip" });
    expect(rep.status).toBe("reproduced");

    const vi = JSON.parse(
      readFileSync(join(dir, "computation", "verifier-input.json"), "utf8"),
    ) as VerifierInput;
    expect(validateInput(vi)).toBeNull();
    expect(inputDigest(vi)).toBe(manifest.computation.inputSha256);
    expect(resultsDigest(computeResults(vi))).toBe(manifest.computation.resultsSha256);

    const thesis = readFileSync(join(dir, "exports", "THESIS.md"), "utf8");
    expect(thesis).toContain("LIVE DATA, AUTOMATED RUN");
    expect(thesis).not.toContain("INSUFFICIENT_DATA");
    expect(thesis).toContain("Daily swaps rose from 100 to 133.");
    expect(checkPublication(thesis, manifest.results).ok).toBe(true);
    // snapshot: the panel files exactly as given, each hashed
    const snap = JSON.parse(readFileSync(join(dir, "snapshot", "snapshot.json"), "utf8")) as {
      files: Array<{ path: string; sha256: string }>;
      kind: string;
    };
    expect(snap.kind).toBe("workspace_run");
    expect(snap.files.map((f) => f.path)).toContain(`raw/panels/${H1}.json`);
    expect(JSON.parse(readFileSync(join(dir, "snapshot", "raw", "panels", `${H1}.json`), "utf8"))).toEqual(
      P1.body,
    );
  });

  it("is deterministic: same input, same capsule id and hash", () => {
    const a = buildWorkspaceRunCapsule(input(), join(tmp("wsrun-"), "cap")).manifest;
    const b = buildWorkspaceRunCapsule(input(), join(tmp("wsrun-"), "cap")).manifest;
    expect(b.capsuleId).toBe(a.capsuleId);
    expect(b.capsuleHash).toBe(a.capsuleHash);
    expect(workspaceRunCapsuleId(WS, "44444444-4444-4444-8444-444444444444")).not.toBe(a.capsuleId);
  });

  it("omits a lag metric when there are too few days, and a SYNTHETIC label for fixture runs", () => {
    const short = (p: RunPanel): RunPanel => ({
      ...p,
      body: {
        ...p.body,
        chart: {
          ...(p.body.chart as object),
          rows: (p.body.chart as { rows: unknown[][] }).rows.slice(0, 5),
        },
      },
    });
    const { build, manifest } = buildWorkspaceRunCapsule(
      input({ source: "fixture", panels: [short(P1), short(P2)], findings: [] }),
      join(tmp("wsrun-"), "cap"),
    );
    expect(build.selection.metrics).toEqual(["pearson", "summary"]);
    expect(manifest.label).toBe("SYNTHETIC");
  });

  it("drops a finding whose numbers are not tied to cited cells and says so without digits", () => {
    const { manifest, build } = buildWorkspaceRunCapsule(
      input({ findings: [finding("Swaps rose by 31 percent.", [fact("100", day(0))])] }),
      join(tmp("wsrun-"), "cap"),
    );
    expect(build.extraThesisNotes).toHaveLength(1);
    expect(build.extraThesisNotes[0]).toMatch(/not restated here/);
    expect(manifest.results.some((r) => r.id.startsWith("f1-"))).toBe(false);
  });

  it("is not capsulable with a plain reason when there are not two daily series", () => {
    const only = panel(H1, "One", ["period", "swaps"], swaps);
    expect(() => buildWorkspaceRunCapsule(input({ panels: [only] }), join(tmp("wsrun-"), "cap"))).toThrow(
      /fewer than two daily numeric series/,
    );
    const a = panel(H1, "A", ["period", "v"], swaps.slice(0, 3));
    const b = panel(
      H2,
      "B",
      ["period", "w"],
      swaps.slice(6, 9).map((r) => [r[0], 5]),
    );
    expect(() => buildWorkspaceRunCapsule(input({ panels: [a, b] }), join(tmp("wsrun-"), "cap"))).toThrow(
      /share at least two consecutive days/,
    );
  });
});
