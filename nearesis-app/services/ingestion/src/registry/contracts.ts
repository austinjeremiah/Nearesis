import type { ContractRegistryEntry } from "@nearesis/contracts";
import { IngestionError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";
import { inInterval } from "./assets.ts";

export interface RegistryRow extends ContractRegistryEntry {
  rowState: "active" | "quarantined";
  conflictGroup: string | null;
}

export interface ConflictReport {
  conflictGroup: string;
  chain: string;
  accountId: string;
  rows: Array<{
    project: string;
    taxonomy: string;
    validFrom: string;
    validTo: string | null;
    ownershipVerification: string;
  }>;
  reason: string;
}

export type ContractLookup =
  | { state: "verified" | "unverified"; entry: RegistryRow }
  | { state: "ambiguous"; conflictGroup: string; report: ConflictReport }
  | { state: "uncategorized" };

export interface Segment {
  project: string | null;
  taxonomy: string;
  segmentState: "verified" | "unverified" | "ambiguous" | "uncategorized";
}

const overlaps = (a: ContractRegistryEntry, b: ContractRegistryEntry): boolean => {
  const aEnd = a.validTo === null ? Infinity : Date.parse(a.validTo);
  const bEnd = b.validTo === null ? Infinity : Date.parse(b.validTo);
  return Date.parse(a.validFrom) < bEnd && Date.parse(b.validFrom) < aEnd;
};

export class ContractRegistry {
  readonly rows: RegistryRow[] = [];
  readonly conflicts: ConflictReport[] = [];
  readonly demoted: Array<{ accountId: string; reason: string }> = [];

  constructor(entries: ContractRegistryEntry[]) {
    // 1. A row marked verified without evidence is never trusted: demote it to unverified.
    const prepared = entries.map((e) => {
      if (e.ownershipVerification === "verified" && !e.evidenceUrl) {
        this.demoted.push({ accountId: e.accountId, reason: "verified without evidence reference" });
        return { ...e, ownershipVerification: "unverified" as const };
      }
      return e;
    });
    // 2. Overlapping rows for one account with different (project, taxonomy) conflict: quarantine them all.
    const bad = new Set<number>();
    const groups = new Map<number, string>();
    prepared.forEach((a, i) => {
      prepared.forEach((b, j) => {
        if (j <= i || a.chain !== b.chain || a.accountId !== b.accountId) return;
        if (!overlaps(a, b)) return;
        if (a.project === b.project && a.taxonomy === b.taxonomy) return;
        bad.add(i);
        bad.add(j);
      });
    });
    const byAcct = new Map<string, number[]>();
    for (const i of bad) {
      const p = prepared[i] as ContractRegistryEntry;
      const k = `${p.chain}|${p.accountId}`;
      byAcct.set(k, [...(byAcct.get(k) ?? []), i]);
    }
    for (const [k, idx] of byAcct) {
      const group = `cg_${sha256Hex(k).slice(0, 12)}`;
      const first = prepared[idx[0] as number] as ContractRegistryEntry;
      for (const i of idx) groups.set(i, group);
      this.conflicts.push({
        conflictGroup: group,
        chain: first.chain,
        accountId: first.accountId,
        rows: idx.map((i) => {
          const r = prepared[i] as ContractRegistryEntry;
          return {
            project: r.project,
            taxonomy: r.taxonomy,
            validFrom: r.validFrom,
            validTo: r.validTo,
            ownershipVerification: r.ownershipVerification,
          };
        }),
        reason: "overlapping validity ranges map one account to different project/taxonomy",
      });
    }
    prepared.forEach((e, i) =>
      this.rows.push({
        ...e,
        rowState: bad.has(i) ? "quarantined" : "active",
        conflictGroup: groups.get(i) ?? null,
      }),
    );
  }

  lookup(chain: string, accountId: string, at: string): ContractLookup {
    if (!Number.isFinite(Date.parse(at)))
      throw new IngestionError("INVALID_INPUT", false, { reason: "lookup requires an effective date" });
    const same = this.rows.filter(
      (r) => r.chain === chain && r.accountId === accountId && inInterval(at, r.validFrom, r.validTo),
    );
    const q = same.find((r) => r.rowState === "quarantined");
    if (q) {
      const report = this.conflicts.find((c) => c.conflictGroup === q.conflictGroup) as ConflictReport;
      return { state: "ambiguous", conflictGroup: report.conflictGroup, report };
    }
    const active = same.filter((r) => r.rowState === "active");
    const hit = active.find((r) => r.ownershipVerification === "verified") ?? active[0];
    if (!hit) return { state: "uncategorized" };
    return { state: hit.ownershipVerification === "verified" ? "verified" : "unverified", entry: hit };
  }

  /** Segment assignment for a receipt. Only verified mappings produce a named segment. */
  assign(chain: string, accountId: string, at: string): Segment {
    const l = this.lookup(chain, accountId, at);
    if (l.state === "verified")
      return { project: l.entry.project, taxonomy: l.entry.taxonomy, segmentState: "verified" };
    if (l.state === "unverified")
      return { project: null, taxonomy: "unverified", segmentState: "unverified" };
    if (l.state === "ambiguous") return { project: null, taxonomy: "unverified", segmentState: "ambiguous" };
    return { project: null, taxonomy: "uncategorized", segmentState: "uncategorized" };
  }

  /**
   * Segment-level aggregate. A project with no verified mapping cannot be a quantitative segment:
   * returns a structured SEGMENT_UNVERIFIED instead of a number.
   */
  segmentAggregate(
    project: string,
    receipts: Array<{ chain: string; accountId: string; at: string; interactions: string }>,
  ):
    | { ok: true; project: string; interactions: string; included: number; excludedUnverified: number }
    | { ok: false; code: "SEGMENT_UNVERIFIED"; project: string; reason: string; retryable: false } {
    const verifiedForProject = this.rows.some(
      (r) => r.project === project && r.rowState === "active" && r.ownershipVerification === "verified",
    );
    if (!verifiedForProject) {
      return {
        ok: false,
        code: "SEGMENT_UNVERIFIED",
        project,
        reason: "no verified ownership mapping exists for this project",
        retryable: false,
      };
    }
    let total = 0n;
    let included = 0;
    let excluded = 0;
    for (const r of receipts) {
      const l = this.lookup(r.chain, r.accountId, r.at);
      if (l.state === "verified" && l.entry.project === project) {
        total += BigInt(r.interactions);
        included++;
      } else if (l.state !== "uncategorized" && (l.state === "ambiguous" || l.entry.project === project))
        excluded++;
    }
    return { ok: true, project, interactions: total.toString(), included, excludedUnverified: excluded };
  }

  assertSegment(project: string): void {
    const r = this.segmentAggregate(project, []);
    if (!r.ok) throw new IngestionError("SEGMENT_UNVERIFIED", false, { reason: r.reason, project });
  }
}
