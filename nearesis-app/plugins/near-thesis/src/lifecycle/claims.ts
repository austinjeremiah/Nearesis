/**
 * Claims stay within the data's limits (ch.19 "Submission anti-patterns", ch.02 H4/H5, ch.14 1Click; ch.16b B13).
 * `scanForbidden` blocks six claim classes; `requiredLabels` states what each kind of panel must say; `labelFor`
 * builds those labels from the panel's data kind so a template cannot silently drop them.
 */
export type ForbiddenClass =
  | "complete_status_fixture"
  | "tee_implies_truth"
  | "explorer_private_history"
  | "quote_as_execution"
  | "oneclick_as_all_intents"
  | "live_mainnet_funds";

export const FORBIDDEN: Array<{ cls: ForbiddenClass; re: RegExp }> = [
  {
    cls: "complete_status_fixture",
    re: /\b(?:fully|completely)\s+(?:verified|complete|validated)\b|\bverification\s+(?:is\s+)?complete\b|\bstatus:\s*complete\b/i,
  },
  {
    cls: "tee_implies_truth",
    re: /\b(?:TEE|enclave|attestation)[- ](?:verified|proves?|guarantees?)\b|\bproves?\s+the\s+hypothesis\b|\bverified\s+on-chain\b/i,
  },
  {
    cls: "explorer_private_history",
    re: /\bprivate\s+(?:user\s+)?(?:transaction\s+)?histor(?:y|ies)\b|\bindividual\s+users?'?s?\s+(?:transaction|swap)\s+histor/i,
  },
  {
    cls: "quote_as_execution",
    re: /\brealized\s+(?:spread|slippage|execution\s+price)\b|\bexecuted\s+(?:spread|price)\b|\bprivacy\s+cost\b/i,
  },
  {
    cls: "oneclick_as_all_intents",
    re: /\ball\s+(?:NEAR\s+)?Intents\s+(?:activity|volume|swaps|flows)\b|\btotal\s+Intents\s+volume\b/i,
  },
  {
    cls: "live_mainnet_funds",
    re: /\blive\s+mainnet\s+funds\b|\bswapped\s+real\s+funds\b|\bexecuted\s+(?:a\s+)?mainnet\s+(?:swap|transaction)\b/i,
  },
];

export interface ForbiddenHit {
  cls: ForbiddenClass;
  phrase: string;
  index: number;
}
export function scanForbidden(text: string): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const { cls, re } of FORBIDDEN) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) hits.push({ cls, phrase: m[0], index: m.index ?? 0 });
  }
  return hits;
}

export type PanelKind = "quote" | "swap_volume" | "post_cutoff" | "generic";
export const SETTLEMENT_CUTOFF = "2026-10-27";

export const LABELS = {
  quote: ["dry quote, not realized execution", "sampled"],
  swap_volume: ["provider-reported 1Click, not all Intents"],
  post_cutoff: [`not observable after ${SETTLEMENT_CUTOFF}`],
} as const;

/** What a panel of this kind must state, plus fixture/live mode and a date on every one. */
export function requiredLabels(kind: PanelKind): string[] {
  return kind === "generic" ? [] : [...LABELS[kind]];
}

/** Builds the label text a composer must attach to a panel (mode and date always included). */
export function labelFor(
  kinds: PanelKind[],
  mode: "fixture" | "live",
  date: string,
  sampledAt?: string,
): string {
  const parts: string[] = [`mode: ${mode}`, `date: ${date}`];
  for (const k of kinds) {
    if (k === "quote") parts.push(LABELS.quote[0], `sampled at ${sampledAt ?? date}`);
    else if (k !== "generic") parts.push(...LABELS[k]);
  }
  return parts.join("; ");
}

export interface LabelSurface {
  id: string;
  kinds: PanelKind[];
  text: string;
  /** How this surface states fixture/live mode (default `mode: fixture|live`; exports state SYNTHETIC or fixture). */
  modePattern?: RegExp;
}

/** A panel spec fragment carrying the labels its data kind requires (mode and date always). */
export function labelledPanel(
  kind: PanelKind,
  o: { title: string; mode: "fixture" | "live"; date: string; sampledAt?: string },
): { title: string; note: string } {
  return { title: o.title, note: labelFor([kind], o.mode, o.date, o.sampledAt) };
}
export interface LabelCheck {
  ok: boolean;
  missing: Array<{ id: string; missing: string[] }>;
}
export function checkLabels(surfaces: LabelSurface[]): LabelCheck {
  const missing: LabelCheck["missing"] = [];
  for (const s of surfaces) {
    const t = s.text.toLowerCase();
    const need = [...new Set(s.kinds.flatMap(requiredLabels))];
    const lacking = need.filter((l) => !t.includes(l.toLowerCase()));
    if (!(s.modePattern ?? /mode:\s*(fixture|live)/i).test(s.text)) lacking.push("mode: fixture|live");
    if (!/\b\d{4}-\d{2}-\d{2}\b/.test(s.text)) lacking.push("date");
    if (lacking.length) missing.push({ id: s.id, missing: lacking });
  }
  return { ok: missing.length === 0, missing };
}
