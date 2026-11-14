import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  GapPublicationBlockedError,
  analyzeGaps,
  publishWithGaps,
  renderLimitations,
  sha256Hex,
} from "../../src/index.ts";
import type { GapFixture, GapType } from "../../src/index.ts";
import { PKG } from "../helpers.ts";

const raw = readFileSync(join(PKG, "fixtures", "gaps", "gaps.json"), "utf8");
const fx = JSON.parse(raw) as GapFixture;

/** V14 (16b): unable-to-compute and missingness are published; undocumented gaps block publication. FIXTURE. */
it("V14: every gap type has a LIMITATIONS entry and a panel status; the variant without entries is blocked naming the entry", () => {
  const pub = publishWithGaps(fx);
  const a = pub.analysis;

  // (a) one entry per gap type, each naming dates or metric and the effect
  const types = new Set<GapType>(a.gaps.map((g) => g.type));
  expect([...types].sort()).toEqual([
    "missing_day",
    "missing_price",
    "private_settlement",
    "uncomputable_metric",
  ]);
  for (const t of types) {
    const entries = pub.limitationsMd.split("\n").filter((l) => l.includes(`[gap:${t}:`));
    expect(entries.length, t).toBe(a.gaps.filter((g) => g.type === t).length);
    for (const e of entries) expect(e.length).toBeGreaterThan(60);
  }
  expect(pub.limitationsMd).toContain("2026-10-24"); // the missing Explorer day
  expect(pub.limitationsMd).toContain("2026-10-29"); // the missing price date
  expect(pub.limitationsMd).toContain("2026-10-27"); // the private-settlement cutoff
  expect(pub.limitationsMd).toContain("m-pearson-constant"); // the uncomputable metric

  // (b) panels carry a status (not only a footnote); nothing is zero-filled or interpolated
  const byPanel = Object.fromEntries(a.panels.map((p) => [p.panelId, p]));
  expect(byPanel["panel-explorer"]).toMatchObject({ status: "partial" });
  expect(byPanel["panel-price"]).toMatchObject({ status: "partial" });
  expect(byPanel["panel-private"]).toMatchObject({ status: "not_observable", value: null });
  expect(byPanel["panel-correlation"]).toMatchObject({ status: "not_computable", value: null });
  for (const p of a.panels.filter((x) => x.gapTags.length > 0)) expect(p.status).not.toBe("ok");
  const explorer = new Map(a.series.explorerDaily);
  expect(explorer.has("2026-10-24")).toBe(false);
  expect(a.series.explorerDaily!.length).toBe(fx.series.explorerDaily!.points.length);
  expect(a.series.explorerDaily!.every(([, v]) => v !== "0")).toBe(true);
  expect(new Map(a.series.priceUsd).has("2026-10-29")).toBe(false);

  // (d) private settlement is not_observable and excluded from public counts
  const privateRows = fx.series.intentsDaily!.privateCounts!.filter(([d]) => d >= "2026-10-27");
  expect(privateRows.every(([, v]) => v === null)).toBe(true);
  const publicSum = fx.series.intentsDaily!.points.reduce((s, [, v]) => s + BigInt(v!), 0n);
  expect(a.publicCounts.intentsPublicTotal).toBe(publicSum.toString());

  // (c) the variant with entries deleted is blocked, naming each missing entry; a partial deletion names only its entry
  const analysis = analyzeGaps(fx);
  let blocked: GapPublicationBlockedError | null = null;
  try {
    publishWithGaps(fx, "# Limitations\n\n");
  } catch (e) {
    blocked = e as GapPublicationBlockedError;
  }
  expect(blocked).toBeInstanceOf(GapPublicationBlockedError);
  expect(blocked!.missing.length).toBe(analysis.gaps.length);
  expect(blocked!.missing).toContain("[gap:missing_day:explorerDaily]");
  expect(blocked!.missing).toContain("[gap:uncomputable_metric:m-pearson-constant]");
  for (const omit of [
    "missing_day",
    "missing_price",
    "private_settlement",
    "uncomputable_metric",
  ] as GapType[]) {
    let err: GapPublicationBlockedError | null = null;
    try {
      publishWithGaps(fx, renderLimitations(analysis, { omit: [omit] }));
    } catch (e) {
      err = e as GapPublicationBlockedError;
    }
    expect(err, omit).not.toBeNull();
    expect(
      err!.missing.every((t) => t.includes(`:${omit}:`)),
      omit,
    ).toBe(true);
  }

  observe({
    testId: "V14",
    observed: `Detected ${a.gaps.length} gaps from the fixture data (types ${[...types].sort().join(", ")}); LIMITATIONS.md has one entry per gap naming dates (2026-10-24, 2026-10-29, cutoff 2026-10-27) or metric m-pearson-constant plus the effect; panels carry statuses ${a.panels.map((p) => `${p.panelId}=${p.status}`).join(", ")}; missing days are absent from the series (no zero, no interpolation); the public intents total ${a.publicCounts.intentsPublicTotal} excludes private settlement. With entries deleted publication is blocked naming ${blocked!.missing.length} missing entries; deleting each gap type's entries individually blocks naming exactly that type.`,
    fixtureHash: sha256Hex(raw),
    evidence: {
      gaps: a.gaps.map((g) => ({ tag: g.tag, dates: g.dates.length })),
      panels: a.panels.map((p) => ({ panel: p.panelId, status: p.status, value: p.value })),
      blockedMissing: blocked!.missing,
    },
  });
}, 60_000);
