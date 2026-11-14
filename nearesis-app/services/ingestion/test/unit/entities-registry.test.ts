import { describe, expect, it } from "vitest";
import { registryV1 } from "../../src/entities/seed-v1.ts";
import { exactMappingsNotObserved, validateRegistry } from "../../src/entities/validate.ts";
import type { Mapping, Registry } from "../../src/entities/types.ts";

const base: Mapping = {
  entityId: "aa",
  network: "near",
  matchType: "exact",
  account: "a.near",
  role: "contract",
  effectiveFrom: "2025-01-01T00:00:00Z",
  effectiveTo: null,
  methodology: "exact receiver id from the cited source",
  verification: "verified",
  confidence: "high",
  evidenceKind: "official_docs",
  evidenceUrl: "https://example.org/docs",
  evidenceNote: "",
  limitations: "calls only",
  precedence: 10,
};
const reg = (mappings: Mapping[], extra: Partial<Registry> = {}): Registry => ({
  registryVersion: "t1",
  publishedAt: "2026-01-01T00:00:00Z",
  entities: [
    {
      entityId: "aa",
      entityType: "application",
      name: "A",
      categoryId: null,
      parentEntityId: null,
      description: "",
    },
    {
      entityId: "bb",
      entityType: "application",
      name: "B",
      categoryId: null,
      parentEntityId: null,
      description: "",
    },
  ],
  mappings,
  relations: [],
  ...extra,
});
const codes = (r: Registry) => validateRegistry(r).map((i) => i.code);

describe("entity registry validation", () => {
  it("the shipped registry v1 is valid and every mapping carries evidence", () => {
    expect(validateRegistry(registryV1)).toEqual([]);
    for (const m of registryV1.mappings) {
      expect(m.evidenceUrl).toMatch(/^https:\/\//);
      expect(m.limitations.length).toBeGreaterThan(5);
      expect(m.methodology.length).toBeGreaterThan(9);
      if (m.verification !== "unverified") expect(m.evidenceKind).not.toBe("none");
    }
    // many contracts per application, and shared infrastructure present as relations (not second attributions)
    const per = new Map<string, number>();
    for (const m of registryV1.mappings) per.set(m.entityId, (per.get(m.entityId) ?? 0) + 1);
    expect(per.get("rhea")).toBeGreaterThanOrEqual(4);
    expect(registryV1.relations.some((r) => r.relation === "uses_infrastructure")).toBe(true);
    expect(registryV1.relations.some((r) => r.relation === "alias_of")).toBe(true);
  });

  it("rejects a mapping with no evidence URL", () => {
    expect(codes(reg([{ ...base, evidenceUrl: "" }]))).toContain("MAPPING_SCHEMA");
  });
  it("rejects verified/inferred mappings without an evidence kind, and verified third-party evidence", () => {
    expect(codes(reg([{ ...base, evidenceKind: "none" }]))).toContain("EVIDENCE_REQUIRED");
    expect(codes(reg([{ ...base, evidenceKind: "third_party" }]))).toContain("VERIFIED_NEEDS_PRIMARY");
    expect(
      codes(reg([{ ...base, evidenceKind: "none", verification: "unverified", confidence: "low" }])),
    ).toEqual([]);
  });
  it("a suffix rule cannot be verified and must start with a dot", () => {
    expect(codes(reg([{ ...base, matchType: "suffix", account: ".x.near" }]))).toContain(
      "SUFFIX_NOT_VERIFIED",
    );
    expect(
      codes(reg([{ ...base, matchType: "suffix", account: "x.near", verification: "inferred" }])),
    ).toContain("SUFFIX_FORMAT");
  });
  it("effective_to must follow effective_from", () => {
    expect(codes(reg([{ ...base, effectiveTo: "2024-12-31T00:00:00Z" }]))).toContain("EFFECTIVE_RANGE");
  });
  it("overlapping rows for one account: equal precedence is rejected, distinct precedence and disjoint intervals are allowed", () => {
    const a = { ...base, effectiveTo: "2025-06-01T00:00:00Z" };
    const b = { ...base, entityId: "bb", effectiveFrom: "2025-05-01T00:00:00Z" };
    expect(codes(reg([a, b]))).toContain("MAPPING_AMBIGUOUS_OVERLAP");
    expect(codes(reg([a, { ...b, precedence: 20 }]))).toEqual([]);
    expect(codes(reg([a, { ...b, effectiveFrom: "2025-06-01T00:00:00Z" }]))).toEqual([]); // effective_to is exclusive
    expect(codes(reg([a, { ...a, effectiveFrom: "2025-05-01T00:00:00Z", effectiveTo: null }]))).toContain(
      "MAPPING_DUPLICATE_OVERLAP",
    );
  });
  it("dangling references are rejected", () => {
    expect(codes(reg([{ ...base, entityId: "zzz" }]))).toContain("MAPPING_ENTITY_UNKNOWN");
    expect(
      codes(
        reg([base], {
          relations: [
            {
              fromEntityId: "aa",
              toEntityId: "nope",
              relation: "alias_of",
              effectiveFrom: null,
              effectiveTo: null,
              verification: "inferred",
              evidenceUrl: "https://example.org",
              note: "",
            },
          ],
        }),
      ),
    ).toContain("RELATION_ENTITY_UNKNOWN");
  });
  it("reports exact mappings that were never observed instead of dropping them", () => {
    const r = reg([base, { ...base, account: "b.near", entityId: "bb" }]);
    expect(exactMappingsNotObserved(r, new Set(["a.near"])).map((m) => m.account)).toEqual(["b.near"]);
  });
});
