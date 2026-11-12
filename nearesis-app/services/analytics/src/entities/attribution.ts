import type { MappingRow, RegistrySnapshot } from "./types.ts";

/**
 * Attribution state of one (receiver, day):
 *  - verified / inferred: counted in the named entity of the winning mapping,
 *  - unverified: the winning mapping is unverified -> counted in the unverified bucket, never in a named entity,
 *  - ambiguous: equally specific, equal-precedence mappings to different entities -> quarantined, never counted,
 *  - unclassified: no mapping is effective -> stays unclassified (never guessed).
 * Exactly ONE state and at most one entity per (receiver, day): that is the no-double-count guarantee.
 *
 * Precedence order: exact beats suffix; among suffixes the longer (more specific) wins; then the lower `precedence`
 * number; equal precedence across different entities is ambiguous.
 */
export type Attribution =
  | { state: "verified" | "inferred"; entityId: string; mapping: MappingRow }
  | { state: "unverified"; entityId: string; mapping: MappingRow }
  | { state: "ambiguous"; candidates: string[] }
  | { state: "unclassified" };

const t = (iso: string): number => Date.parse(iso);
const active = (m: MappingRow, at: number): boolean =>
  t(m.effectiveFrom) <= at && (m.effectiveTo === null || at < t(m.effectiveTo));
const matches = (m: MappingRow, account: string): boolean =>
  m.matchType === "exact"
    ? m.account === account
    : account.endsWith(m.account) && account.length > m.account.length;
const specificity = (m: MappingRow): number => (m.matchType === "exact" ? 1_000_000 : m.account.length);

export class Attributor {
  private readonly exact = new Map<string, MappingRow[]>();
  private readonly suffixes: MappingRow[];

  constructor(reg: Pick<RegistrySnapshot, "mappings">, network = "near") {
    const ms = reg.mappings.filter((m) => m.network === network);
    for (const m of ms.filter((x) => x.matchType === "exact")) {
      const l = this.exact.get(m.account) ?? [];
      l.push(m);
      this.exact.set(m.account, l);
    }
    this.suffixes = ms.filter((x) => x.matchType === "suffix");
  }

  resolve(account: string, date: string): Attribution {
    const at = t(`${date}T00:00:00Z`);
    const cands = [
      ...(this.exact.get(account) ?? []).filter((m) => active(m, at)),
      ...this.suffixes.filter((m) => matches(m, account) && active(m, at)),
    ];
    if (!cands.length) return { state: "unclassified" };
    cands.sort((a, b) => specificity(b) - specificity(a) || a.precedence - b.precedence);
    const top = cands[0]!;
    const tied = cands.filter((m) => specificity(m) === specificity(top) && m.precedence === top.precedence);
    const entities = [...new Set(tied.map((m) => m.entityId))];
    if (entities.length > 1) return { state: "ambiguous", candidates: entities.sort() };
    return { state: top.verification, entityId: top.entityId, mapping: top } as Attribution;
  }
}
