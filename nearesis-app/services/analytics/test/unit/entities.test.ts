import { describe, expect, it } from "vitest";
import {
  Attributor,
  CANNOT_COMPUTE_UNIQUE_USERS,
  entityChanges,
  entityDaily,
  windowCoverage,
} from "../../src/entities/index.ts";
import type { ActivityInput, EntityRow, MappingRow, RegistrySnapshot } from "../../src/entities/index.ts";

const ent = (
  id: string,
  type: EntityRow["entityType"] = "application",
  categoryId: string | null = null,
): EntityRow => ({
  entityId: id,
  entityType: type,
  name: id,
  categoryId,
  parentEntityId: null,
  description: "",
  registryVersion: "t",
});
const map = (o: Partial<MappingRow> & Pick<MappingRow, "entityId" | "account">): MappingRow => ({
  mappingId: `${o.entityId}:${o.account}`,
  network: "near",
  matchType: "exact",
  role: "contract",
  effectiveFrom: "2026-01-01T00:00:00Z",
  effectiveTo: null,
  registryVersion: "t",
  methodology: "m",
  verification: "verified",
  confidence: "high",
  evidenceKind: "onchain",
  evidenceUrl: "https://e.org",
  evidenceNote: "",
  limitations: "l",
  precedence: 10,
  ...o,
});
const reg = (mappings: MappingRow[]): RegistrySnapshot => ({
  registryVersion: "t",
  entities: [
    ent("cat.x", "category"),
    ent("app", "application", "cat.x"),
    ent("other", "application", "cat.x"),
    ent("infra", "infrastructure"),
  ],
  mappings,
  relations: [],
});

describe("attribution rules", () => {
  const r = reg([
    map({ entityId: "app", account: "app.near" }),
    map({ entityId: "infra", account: ".near", matchType: "suffix", verification: "inferred" }),
    map({ entityId: "other", account: ".app.near", matchType: "suffix", verification: "inferred" }),
    map({
      entityId: "other",
      account: "old.near",
      effectiveFrom: "2026-02-01T00:00:00Z",
      effectiveTo: "2026-03-01T00:00:00Z",
    }),
    map({ entityId: "app", account: "u.near", verification: "unverified", confidence: "low" }),
    map({ entityId: "app", account: "tie.near", precedence: 5 }),
    map({ entityId: "other", account: "tie.near", precedence: 5 }),
  ]);
  const a = new Attributor(r);
  it("exact beats suffix, longer suffix beats shorter", () => {
    expect(a.resolve("app.near", "2026-05-01")).toMatchObject({ state: "verified", entityId: "app" });
    expect(a.resolve("x.app.near", "2026-05-01")).toMatchObject({ state: "inferred", entityId: "other" });
    expect(a.resolve("y.near", "2026-05-01")).toMatchObject({ state: "inferred", entityId: "infra" });
  });
  it("is date-correct: from inclusive, to exclusive", () => {
    expect(a.resolve("old.near", "2026-01-31").state).toBe("inferred");
    expect(a.resolve("old.near", "2026-02-01")).toMatchObject({ state: "verified", entityId: "other" });
    expect(a.resolve("old.near", "2026-02-28")).toMatchObject({ state: "verified", entityId: "other" });
    expect(a.resolve("old.near", "2026-03-01").state).toBe("inferred");
    expect(a.resolve("app.near", "2025-12-31")).toEqual({ state: "unclassified" });
  });
  it("unverified is not a named classification; ties are ambiguous; unknown stays unclassified", () => {
    expect(a.resolve("u.near", "2026-05-01").state).toBe("unverified");
    expect(a.resolve("tie.near", "2026-05-01")).toEqual({ state: "ambiguous", candidates: ["app", "other"] });
    expect(a.resolve("nothing.example", "2026-05-01")).toEqual({ state: "unclassified" });
  });
});

const days = (from: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );

/** 4 days prior (10-01..10-04), 4 days current (10-05..10-08). */
function activity(): ActivityInput {
  const receivers: ActivityInput["receivers"] = [];
  for (const d of days("2026-10-01", 8)) {
    const cur = d >= "2026-10-05";
    receivers.push({ date: d, receiver: "app.near", interactions: cur ? 300 : 100 });
    receivers.push({ date: d, receiver: "x.app.near", interactions: 50 }); // sub-account: resolves to ONE entity
    receivers.push({ date: d, receiver: "z.near", interactions: cur ? 500 : 100 }); // infra suffix
    receivers.push({ date: d, receiver: "mystery.example", interactions: cur ? 1000 : 200 }); // unclassified
    receivers.push({ date: d, receiver: "u.near", interactions: 10 }); // unverified
  }
  return { receivers, remainder: days("2026-10-01", 8).map((date) => ({ date, interactions: 7 })) };
}
const R = reg([
  map({ entityId: "app", account: "app.near" }),
  map({ entityId: "other", account: ".app.near", matchType: "suffix", verification: "inferred" }),
  map({ entityId: "infra", account: ".near", matchType: "suffix", verification: "inferred" }),
  map({ entityId: "app", account: "u.near", verification: "unverified", confidence: "low" }),
]);

describe("entity metrics: no double counting and explicit coverage", () => {
  const rep = entityChanges(R, activity(), "2026-10-08", 4);
  it("every receiver-day lands in exactly one bucket: entity totals + unverified + ambiguous + unclassified + remainder = total", () => {
    const c = rep.currentCoverage;
    const named = rep.entities.reduce((s, e) => s + e.current.interactions, 0);
    expect(named).toBe(c.classifiedInteractions);
    expect(
      named +
        c.unverifiedInteractions +
        c.ambiguousInteractions +
        c.unclassifiedListedInteractions +
        c.belowThresholdInteractions,
    ).toBe(c.totalInteractions);
    // the sub-account x.app.near is counted once, under "other" only, and is NOT also added to "app"
    const app = rep.entities.find((e) => e.entityId === "app")!;
    const other = rep.entities.find((e) => e.entityId === "other")!;
    expect(app.current.interactions).toBe(1200);
    expect(other.current.interactions).toBe(200);
    expect(rep.entities.find((e) => e.entityId === "infra")!.current.interactions).toBe(2000);
  });
  it("reports classified vs unclassified coverage and keeps unverified out of named entities", () => {
    const c = rep.currentCoverage;
    expect(c.totalInteractions).toBe(1200 + 200 + 2000 + 4000 + 40 + 28);
    expect(c.unverifiedInteractions).toBe(40);
    expect(c.unclassifiedListedInteractions).toBe(4000);
    expect(c.belowThresholdInteractions).toBe(28);
    expect(c.classifiedShare + c.unverifiedShare + c.ambiguousShare + c.unclassifiedShare).toBeCloseTo(1, 12);
    expect(c.missingDays).toEqual([]);
    expect(rep.entities.every((e) => e.coverage.classifiedShare === c.classifiedShare)).toBe(true);
  });
  it("period-over-period change and ranking", () => {
    const app = rep.entities.find((e) => e.entityId === "app")!;
    expect(app.prior.interactions).toBe(400);
    expect(app.change).toBe(800);
    expect(app.changePct).toBe(2);
    expect(rep.entities[0]!.entityId).toBe("infra"); // +1600 is the largest rise
    expect(rep.totals.change).toBe(rep.totals.classifiedChange + rep.totals.unclassifiedChange);
    expect(rep.unattributedGrowth[0]).toMatchObject({ receiver: "mystery.example", change: 3200 });
    expect(rep.categories[0]).toMatchObject({ categoryId: "cat.x" });
  });
  it("flags missing days instead of treating them as zero", () => {
    const a = activity();
    a.receivers = a.receivers.filter((r) => r.date !== "2026-10-06");
    const p = entityChanges(R, a, "2026-10-08", 4);
    expect(p.currentCoverage.missingDays).toEqual(["2026-10-06"]);
    expect(p.entities.every((e) => e.coverage.windowCoverage === "partial")).toBe(true);
  });
  it("daily grain series and coverage listing", () => {
    const d = entityDaily(R, activity(), "app", "2026-10-04", "2026-10-06");
    expect(d.points.map((p) => [p.date, p.interactions])).toEqual([
      ["2026-10-04", 100],
      ["2026-10-05", 300],
      ["2026-10-06", 300],
    ]);
    expect(d.points[1]!.shareOfTotal).toBeCloseTo(300 / (300 + 50 + 500 + 1000 + 10 + 7), 12);
    const cov = windowCoverage(R, activity(), "2026-10-05", "2026-10-08");
    expect(cov.topUnclassifiedReceivers[0]).toEqual({ receiver: "mystery.example", interactions: 4000 });
    expect(cov.topUnverifiedReceivers[0]).toEqual({ receiver: "u.near", interactions: 40 });
  });
  it("an account touching five contracts is not five users: unique users is CANNOT_COMPUTE, never a sum of contract counts", () => {
    expect(rep.uniqueUsers).toBe(CANNOT_COMPUTE_UNIQUE_USERS);
    expect(rep.uniqueUsers.state).toBe("CANNOT_COMPUTE");
    expect(rep.uniqueUsers.missingSource).toMatch(/signer_account_id x receiver_account_id x block_date/);
  });
});
