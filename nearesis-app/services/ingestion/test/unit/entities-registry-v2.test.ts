import { describe, expect, it } from "vitest";
import { registryV1 } from "../../src/entities/seed-v1.ts";
import { newMappings, registryV2, UNCLASSIFIED_NOTES } from "../../src/entities/seed-v2.ts";
import { validateRegistry } from "../../src/entities/validate.ts";

const PRIMARY = new Set(["official_docs", "official_repo", "explorer_label", "onchain"]);
const accounts = new Set(registryV2.mappings.map((m) => m.account));

describe("entity registry v2", () => {
  it("is valid and keeps v1 intact as a separate version", () => {
    expect(validateRegistry(registryV2)).toEqual([]);
    expect(registryV2.registryVersion).toBe("v2");
    expect(registryV1.registryVersion).toBe("v1");
    expect(registryV1.mappings).toHaveLength(33);
    expect(registryV1.entities).toHaveLength(27);
    // v2 only adds to v1 apart from the two evidence-upgraded accounts
    const v2Keys = new Set(registryV2.mappings.map((m) => `${m.entityId}|${m.account}|${m.verification}`));
    const dropped = registryV1.mappings
      .filter((m) => !v2Keys.has(`${m.entityId}|${m.account}|${m.verification}`))
      .map((m) => m.account);
    expect(dropped.sort()).toEqual(["client-eth2.bridge.near", "contract.wormhole_crypto.near"]);
    for (const e of registryV1.entities)
      expect(registryV2.entities.some((x) => x.entityId === e.entityId)).toBe(true);
  });

  it("every new mapping carries evidence: https URL, note, limitations, a real evidence kind", () => {
    expect(newMappings.length).toBeGreaterThanOrEqual(25);
    for (const m of newMappings) {
      expect(m.evidenceUrl).toMatch(/^https:\/\//);
      expect(m.evidenceNote.length).toBeGreaterThan(20);
      expect(m.limitations.length).toBeGreaterThan(10);
      expect(m.methodology.length).toBeGreaterThan(9);
      expect(m.verification).not.toBe("unverified");
      expect(m.evidenceKind).not.toBe("none");
      expect(m.evidenceKind).not.toBe("third_party");
    }
  });

  it("verified rows cite a primary source and are exact; inferred rows are never high-confidence guesses", () => {
    for (const m of newMappings) {
      if (m.verification === "verified") {
        expect(PRIMARY.has(m.evidenceKind)).toBe(true);
        expect(m.matchType).toBe("exact");
        expect(["official_docs", "official_repo"]).toContain(m.evidenceKind);
      } else {
        expect(m.confidence).not.toBe("high");
      }
    }
    // contracts that only identify themselves on-chain must not claim an owner
    for (const id of ["nft.cooldogsclub", "ft.unites", "nft.mrbrown", "nft.tigeracademy"]) {
      const rows = newMappings.filter((m) => m.entityId === id);
      expect(rows.length).toBeGreaterThan(0);
      for (const m of rows) {
        expect(m.verification).toBe("inferred");
        expect(m.evidenceKind).toBe("onchain");
        expect(m.limitations).toMatch(/[Oo]wner not established/);
      }
    }
  });

  it("no overlap: one entity per exact account, equal-precedence suffix clashes absent, effective dates sane", () => {
    const exact = new Map<string, Set<string>>();
    for (const m of registryV2.mappings.filter((x) => x.matchType === "exact")) {
      const s = exact.get(m.account) ?? new Set();
      s.add(m.entityId);
      exact.set(m.account, s);
    }
    for (const [a, s] of exact) expect([a, s.size]).toEqual([a, 1]);
    for (const m of newMappings) {
      expect(Date.parse(m.effectiveFrom)).toBeLessThanOrEqual(Date.parse("2026-11-13T00:00:00Z"));
      expect(m.effectiveTo).toBeNull();
    }
    // a new exact row that sits under an older suffix rule of ANOTHER entity must be strictly more specific (exact beats suffix)
    for (const m of newMappings.filter((x) => x.matchType === "exact")) {
      const shadowed = registryV2.mappings.filter(
        (s) => s.matchType === "suffix" && s.entityId !== m.entityId && m.account.endsWith(s.account),
      );
      for (const s of shadowed) expect(s.account).toBe(".bridge.near"); // the unverified namespace bucket only
    }
  });

  it("v1 unverified rows are replaced by verified rows, not duplicated", () => {
    for (const a of ["client-eth2.bridge.near", "contract.wormhole_crypto.near"]) {
      const rows = registryV2.mappings.filter((m) => m.account === a);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.verification).toBe("verified");
    }
  });

  it("receivers checked without sufficient evidence stay unmapped, each with a note of what was checked", () => {
    for (const [a, note] of Object.entries(UNCLASSIFIED_NOTES)) {
      expect(accounts.has(a)).toBe(false);
      expect(note.length).toBeGreaterThan(20);
    }
  });
});
