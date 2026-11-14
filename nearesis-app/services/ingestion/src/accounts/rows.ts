import { IngestionError } from "../errors.ts";
import type { BqRow } from "../backfill/bq-runner.ts";
import { bqScalar, type Provenance, type Row } from "../backfill/ch.ts";
import { ACCOUNT_RULE_VERSION } from "../backfill/account-sql.ts";

const bad = (reason: string, extra: Record<string, unknown> = {}): never => {
  throw new IngestionError("INVALID_INPUT", false, { reason, ...extra });
};
const uint = (v: unknown, field: string): bigint => {
  const s = bqScalar(v, field);
  if (!/^\d+$/.test(s)) return bad("not an unsigned integer", { field });
  return BigInt(s);
};
const dayOf = (v: unknown, field = "block_date"): string => {
  const s = bqScalar(v, field).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return bad("not a date", { field });
  return s;
};
const epochDay = (n: bigint): string => new Date(Number(n) * 86_400_000).toISOString().slice(0, 10);

export interface ScanRows {
  head: Row[];
  tail: Row[];
  entity: Row[];
  newReturning: Row[];
  retention: Row[];
  profile: Row[];
  days: string[]; // days present in the result (day_a), sorted
}

/**
 * Splits the single result set by kind, applies exact BigInt arithmetic and verifies the internal identities BEFORE anything
 * is loaded (a violated identity means a wrong query or a truncated result: the raw archive stays, the load does not happen):
 *  - head count + tail_signers = signers_org and head tx + tail_tx = tx_org (per day, exact);
 *  - new + returning = signers_org; new_tx + returning_tx = tx_org;
 *  - sum over entity buckets of tx_all = tx_all and of tx_organic = tx_org (buckets partition receivers, so transactions add);
 *  - cohort week sizes sum to the total of new signers (the window-start day's "new" = all signers active that day).
 * A day present in day_a without day_b rows has no organic signer: all organic figures are exactly 0.
 */
export function scanRows(
  rows: BqRow[],
  p: Provenance,
  opts: { head: number; windowStart: string; registryVersion: string },
): ScanRows {
  const prov = {
    source_label: "LIVE",
    raw_object_hash: p.rawObjectHash,
    fetched_at: p.fetchedAtUTC,
    version: Date.parse(p.fetchedAtUTC),
  };
  const common = { account_rule_version: ACCOUNT_RULE_VERSION, window_start: opts.windowStart };
  const dayA = new Map<string, BqRow>();
  const dayB = new Map<string, BqRow>();
  const head: Row[] = [];
  const entity: Row[] = [];
  const retention: Row[] = [];
  const profile: Row[] = [];
  const seenHead = new Set<string>();
  const headN = new Map<string, bigint>();
  const headTx = new Map<string, bigint>();
  for (const r of rows) {
    const kind = String(r.kind);
    if (kind === "head") {
      const d = dayOf(r.block_date);
      const key = String(r.key ?? "");
      if (!key) bad("head row without signer");
      if (seenHead.has(`${d}|${key}`)) bad("duplicate head row", { d, key });
      seenHead.add(`${d}|${key}`);
      const n = uint(r.v1, "v1");
      if (n < BigInt(opts.head)) bad("head row below the threshold", { d, key });
      headN.set(d, (headN.get(d) ?? 0n) + 1n);
      headTx.set(d, (headTx.get(d) ?? 0n) + n);
      head.push({
        block_date: d,
        signer_account_id: key,
        tx_organic: n.toString(),
        head_threshold: opts.head,
        ...common,
        ...prov,
      });
    } else if (kind === "day_a") {
      const d = dayOf(r.block_date);
      if (dayA.has(d)) bad("duplicate day_a row", { d });
      dayA.set(d, r);
    } else if (kind === "day_b") {
      const d = dayOf(r.block_date);
      if (dayB.has(d)) bad("duplicate day_b row", { d });
      dayB.set(d, r);
    } else if (kind === "entity") {
      entity.push({
        block_date: dayOf(r.block_date),
        entity_bucket: String(r.key ?? bad("entity row without bucket")),
        signers_all: uint(r.v1, "v1").toString(),
        tx_all: uint(r.v2, "v2").toString(),
        signers_organic: uint(r.v3, "v3").toString(),
        tx_organic: uint(r.v4, "v4").toString(),
        registry_version: opts.registryVersion,
        ...common,
        ...prov,
      });
    } else if (kind === "retention") {
      retention.push({
        cohort_week: dayOf(r.key, "cohort_week"),
        active_week: dayOf(r.block_date),
        signers: uint(r.v1, "v1").toString(),
        ...common,
        ...prov,
      });
    } else if (kind === "profile") {
      profile.push({
        signer_account_id: String(r.key ?? bad("profile row without signer")),
        first_seen_in_window: dayOf(r.block_date),
        last_seen_in_window: epochDay(uint(r.v1, "v1")),
        active_days: uint(r.v2, "v2").toString(),
        tx_organic: uint(r.v3, "v3").toString(),
        head_days: uint(r.v4, "v4").toString(),
        ...common,
        ...prov,
      });
    } else bad("unknown row kind", { kind });
  }

  const days = [...dayA.keys()].sort();
  const tail: Row[] = [];
  const newReturning: Row[] = [];
  let totalNew = 0n;
  const entTx = new Map<string, [bigint, bigint]>();
  for (const e of entity) {
    const d = e.block_date as string;
    const [a, o] = entTx.get(d) ?? [0n, 0n];
    entTx.set(d, [a + BigInt(e.tx_all as string), o + BigInt(e.tx_organic as string)]);
  }
  for (const d of days) {
    const a = dayA.get(d) as BqRow;
    const b = dayB.get(d);
    const signersAll = uint(a.v1, "signers_all");
    const txAll = uint(a.v2, "tx_all");
    const txInt = uint(a.v3, "tx_intents");
    const txBr = uint(a.v4, "tx_bridge");
    const signersInt = uint(a.v5, "signers_with_intents");
    const sigOrg = uint(a.v6, "signers_org");
    const txOrg = uint(a.v7, "tx_org");
    const top10 = uint(a.v8, "top10_tx");
    const z = (v: unknown, f: string): bigint => (b ? uint(v, f) : 0n);
    const tailS = z(b?.v1, "tail_signers");
    const tailT = z(b?.v2, "tail_tx");
    const newS = z(b?.v3, "new_signers");
    const newT = z(b?.v4, "new_tx");
    if (txInt + txBr > txAll) bad("intents+bridge exceed total", { d });
    if (txAll - txInt - txBr !== txOrg) bad("organic tx identity violated", { d });
    if ((headN.get(d) ?? 0n) + tailS !== sigOrg) bad("head + tail signers != organic signers", { d });
    if ((headTx.get(d) ?? 0n) + tailT !== txOrg) bad("head + tail tx != organic tx", { d });
    if (newS > sigOrg || newT > txOrg) bad("new exceeds active", { d });
    const [eAll, eOrg] = entTx.get(d) ?? [0n, 0n];
    if (eAll !== txAll || eOrg !== txOrg) bad("entity buckets do not partition the day transactions", { d });
    totalNew += newS;
    tail.push({
      block_date: d,
      tail_signers: tailS.toString(),
      tail_tx: tailT.toString(),
      head_threshold: opts.head,
      ...common,
      ...prov,
    });
    newReturning.push({
      block_date: d,
      signers_all: signersAll.toString(),
      tx_all: txAll.toString(),
      tx_intents: txInt.toString(),
      tx_bridge: txBr.toString(),
      signers_with_intents: signersInt.toString(),
      signers_organic: sigOrg.toString(),
      tx_organic: txOrg.toString(),
      new_signers: newS.toString(),
      returning_signers: (sigOrg - newS).toString(),
      new_tx: newT.toString(),
      returning_tx: (txOrg - newT).toString(),
      top10_tx: top10.toString(),
      top1pct_signer_count: z(b?.v5, "top1_count").toString(),
      top1pct_tx: z(b?.v6, "top1_tx").toString(),
      top5pct_signer_count: z(b?.v7, "top5_count").toString(),
      top5pct_tx: z(b?.v8, "top5_tx").toString(),
      ...common,
      ...prov,
    });
  }
  for (const d of dayB.keys()) if (!dayA.has(d)) bad("day_b row without day_a", { d });
  const cohortSizes = retention
    .filter((r) => r.cohort_week === r.active_week)
    .reduce((a, r) => a + BigInt(r.signers as string), 0n);
  // A cohort's own-week row counts cohort signers active that week = ALL of them (each is first seen inside it).
  if (cohortSizes !== totalNew)
    bad("cohort sizes do not sum to the new-signer total", {
      cohortSizes: String(cohortSizes),
      totalNew: String(totalNew),
    });
  return { head, tail, entity, newReturning, retention, profile, days };
}
