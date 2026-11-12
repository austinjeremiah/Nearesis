import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it } from "vitest";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { BigQueryLike } from "../adapters/bigquery.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "../backfill/budget.ts";
import { ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { loadAccountScan } from "./load.ts";
import { reconcileScan } from "./reconcile.ts";
import { scanRows } from "./rows.ts";
import { AccountScanState, runAccountScan } from "./run.ts";
import { accountScanSql, monthChunks, sqlDigest, type MappingInput } from "./sql.ts";

const m = (o: Partial<MappingInput> & Pick<MappingInput, "entityId" | "account">): MappingInput => ({
  mappingId: `v1:${o.entityId}:${o.account}`,
  network: "near",
  matchType: "exact",
  effectiveFrom: "2025-11-10T00:00:00Z",
  effectiveTo: null,
  verification: "verified",
  precedence: 10,
  ...o,
});
const mappings: MappingInput[] = [
  m({ entityId: "rhea", account: "v2.ref-finance.near" }),
  m({ entityId: "sweat", account: ".sweat", matchType: "suffix", verification: "inferred", precedence: 100 }),
  m({
    entityId: "wormhole",
    account: "contract.wormhole_crypto.near",
    verification: "unverified",
    precedence: 5,
  }),
];
const chunk = { from: "2025-11-10", to: "2025-11-13" };

describe("account scan SQL", () => {
  const sql = accountScanSql(chunk, mappings);
  it("passes the static guard, reads transactions once, is block_date bounded and has no OR keyword", () => {
    const v = assertGuardedSql(sql);
    expect(v.tables).toHaveLength(1);
    expect(v.tables[0]!.bounded).toBe(true);
    expect(sql).not.toMatch(/\bOR\b/i);
    expect(sql.match(/crypto_near_mainnet_us\.transactions/g)).toHaveLength(1);
  });
  it("scans only block_date, signer_account_id and receiver_account_id", () => {
    const cols = [...sql.matchAll(/\bt\.([a-z_]+)/g)].map((x) => x[1]);
    expect(new Set(cols)).toEqual(new Set(["block_date", "signer_account_id", "receiver_account_id"]));
    expect(sql).not.toMatch(/SELECT\s+\*\s+FROM\s+`bigquery/i);
  });
  it("embeds the registry mapping table and keeps the organic rule of the account backfill", () => {
    expect(sql).toContain("'v2.ref-finance.near' AS account");
    expect(sql).toContain("'.sweat' AS account");
    expect(sql).toContain("CAST(NULL AS TIMESTAMP) AS eff_to");
    expect(sql).toContain("'intents.near', 'verifier2.near'");
    expect(sql).toContain("'.omft.near'");
    expect(sql).toContain("n_org >= 100");
    expect(sql).toContain("n_org < 100"); // the tail is an exact remainder, not dropped
  });
  it("is deterministic and mapping order independent; any change changes the digest", () => {
    expect(sqlDigest(sql)).toBe(sqlDigest(accountScanSql(chunk, [...mappings].reverse())));
    expect(sqlDigest(sql)).not.toBe(sqlDigest(accountScanSql(chunk, mappings, 50)));
    expect(sqlDigest(sql)).not.toBe(sqlDigest(accountScanSql({ ...chunk, to: "2025-11-14" }, mappings)));
  });
  it("rejects injection-shaped literals and bad bounds", () => {
    expect(() => accountScanSql(chunk, [m({ entityId: "x'; DROP", account: "a" })])).toThrow();
    expect(() => accountScanSql({ from: "2025-11-10", to: "x" }, mappings)).toThrow();
    expect(() => accountScanSql(chunk, [])).toThrow();
    expect(() => accountScanSql(chunk, mappings, 1)).toThrow();
  });
  it("month chunks tile the window newest first and every one passes the guard", () => {
    const cs = monthChunks("2025-11-10", "2026-11-12");
    expect(cs).toHaveLength(13);
    expect(cs[0]).toMatchObject({ from: "2026-11-01", to: "2026-11-12" });
    expect(cs[12]).toMatchObject({ from: "2025-11-10", to: "2025-12-01" });
    for (let i = 0; i < 12; i++) expect(cs[i + 1]!.to).toBe(cs[i]!.from);
    for (const c of cs) expect(() => assertGuardedSql(accountScanSql(c, mappings))).not.toThrow();
  });
});

const d = (v: string) => ({ value: v });
const P = { rawObjectHash: "h", fetchedAtUTC: "2026-11-13T09:00:00.000Z" };
const O = { head: 100, windowStart: "2025-11-10", registryVersion: "v1" };
// Day 1 (window start): 5 organic signers (2 head: 300, 150; 3 tail: 20+10+5), 1 intents-only signer. Day 2: 4 organic signers (1 head 120; tail 3: 7+3+1; 2 new).
const row = (kind: string, date: string, key: string | null, v: Array<number | null>) => ({
  kind,
  block_date: d(date),
  key,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`v${i + 1}`, v[i] ?? null])),
});
const good = () => [
  row("head", "2025-11-10", "whale.near", [300]),
  row("head", "2025-11-10", "bot.near", [150]),
  row("head", "2025-11-11", "whale.near", [120]),
  // signers_all, tx_all, tx_int, tx_br, signers_with_intents, signers_org, tx_org, top10
  row("day_a", "2025-11-10", null, [6, 600, 100, 0, 1, 5, 485 - 0 + 0, 485]),
  row("day_a", "2025-11-11", null, [4, 131, 0, 0, 0, 4, 131, 131]),
  // tail_signers, tail_tx, new_signers, new_tx, top1c, top1t, top5c, top5t
  row("day_b", "2025-11-10", null, [3, 35, 5, 485, 1, 300, 1, 300]),
  row("day_b", "2025-11-11", null, [3, 11, 2, 10, 1, 120, 1, 120]),
  row("entity", "2025-11-10", "__unclassified__", [6, 600, 5, 485]),
  row("entity", "2025-11-11", "__unclassified__", [4, 131, 4, 131]),
  row("retention", "2025-11-10", "2025-11-10", [5]),
  row("retention", "2025-11-10", "2025-11-10", [5]),
];
// make the fixture exactly consistent: day 1 organic tx = 300+150+35 = 485, intents 100, all = 585 -> fix below
const fixture = () => {
  const r = good();
  r.splice(
    r.findIndex((x) => x.kind === "day_a" && (x.block_date as { value: string }).value === "2025-11-10"),
    1,
    row("day_a", "2025-11-10", null, [6, 585, 100, 0, 1, 5, 485, 485]),
  );
  const e = r.findIndex(
    (x) => x.kind === "entity" && (x.block_date as { value: string }).value === "2025-11-10",
  );
  r.splice(e, 1, row("entity", "2025-11-10", "__unclassified__", [6, 585, 5, 485]));
  // day 1 cohort (own week): 5 signers; day 2 new signers 2 -> cohort week of 2025-11-10 holds 7 in total (same week)
  const ret = r.filter((x) => x.kind === "retention");
  for (const x of ret) r.splice(r.indexOf(x), 1);
  r.push(row("retention", "2025-11-10", "2025-11-10", [7]));
  // day 2 returning: 4 active, 2 new -> make head+tail consistent: head 1 (120) + tail 3 (11) = 131
  return r;
};

describe("scan rows", () => {
  it("splits kinds, applies exact arithmetic and derives returning = active - new", () => {
    const s = scanRows(fixture(), P, O);
    expect(s.days).toEqual(["2025-11-10", "2025-11-11"]);
    expect(s.head).toHaveLength(3);
    expect(s.tail.map((t) => [t.tail_signers, t.tail_tx])).toEqual([
      ["3", "35"],
      ["3", "11"],
    ]);
    expect(s.newReturning.map((n) => [n.new_signers, n.returning_signers, n.new_tx, n.returning_tx])).toEqual(
      [
        ["5", "0", "485", "0"],
        ["2", "2", "10", "121"],
      ],
    );
    expect(s.newReturning[0]).toMatchObject({ window_start: "2025-11-10", tx_organic: "485" });
    expect(s.entity).toHaveLength(2);
  });
  it("conserves the day total: head + tail = organic", () => {
    const s = scanRows(fixture(), P, O);
    for (const day of s.days) {
      const head = s.head
        .filter((h) => h.block_date === day)
        .reduce((a, h) => a + BigInt(h.tx_organic as string), 0n);
      const tail = BigInt(s.tail.find((t) => t.block_date === day)!.tail_tx as string);
      expect(head + tail).toBe(
        BigInt(s.newReturning.find((n) => n.block_date === day)!.tx_organic as string),
      );
    }
  });
  it("refuses results that break an identity (nothing may be loaded)", () => {
    const withTail = (v: Array<number | null>) =>
      fixture().map((x) =>
        x.kind === "day_b" && (x.block_date as { value: string }).value === "2025-11-10"
          ? row("day_b", "2025-11-10", null, v)
          : x,
      );
    expect(() => scanRows(withTail([3, 34, 5, 485, 1, 300, 1, 300]), P, O)).toThrow(/head \+ tail tx/);
    expect(() => scanRows(withTail([2, 35, 5, 485, 1, 300, 1, 300]), P, O)).toThrow(/head \+ tail signers/);
    expect(() => scanRows(withTail([3, 35, 9, 485, 1, 300, 1, 300]), P, O)).toThrow(/new exceeds/);
    expect(() =>
      scanRows(
        fixture().filter(
          (x) => x.kind !== "entity" || (x.block_date as { value: string }).value !== "2025-11-11",
        ),
        P,
        O,
      ),
    ).toThrow(/partition/);
    expect(() => scanRows([...fixture(), row("head", "2025-11-10", "x.near", [99])], P, O)).toThrow(
      /below the threshold/,
    );
    expect(() => scanRows([...fixture(), row("head", "2025-11-10", "whale.near", [300])], P, O)).toThrow(
      /duplicate head/,
    );
    expect(() => scanRows([...fixture(), row("mystery", "2025-11-10", null, [1])], P, O)).toThrow(
      /unknown row kind/,
    );
    expect(() =>
      scanRows(
        fixture().map((x) =>
          x.kind === "retention" ? row("retention", "2025-11-10", "2025-11-10", [6]) : x,
        ),
        P,
        O,
      ),
    ).toThrow(/cohort sizes/);
  });
  it("a covered day with no organic signer has exact zero organic figures", () => {
    const r = [
      row("day_a", "2025-11-10", null, [1, 50, 50, 0, 1, 0, 0, 0]),
      row("entity", "2025-11-10", "near-intents", [1, 50, 0, 0]),
    ];
    const s = scanRows(r, P, O);
    expect(s.newReturning[0]).toMatchObject({ signers_organic: "0", new_signers: "0", tx_organic: "0" });
    expect(s.tail[0]).toMatchObject({ tail_signers: "0", tail_tx: "0" });
  });
});

const fakeBq = (
  calls: Array<{ dryRun?: boolean; maximumBytesBilled?: string }>,
  bytes: number,
): BigQueryLike =>
  ({
    getProjectId: async () => "p",
    getDatasetMetadata: async () => ({ location: "us-east1" }),
    createQueryJob: async (o: { dryRun?: boolean; maximumBytesBilled?: string }) => {
      calls.push(o);
      return [
        {
          id: "job1",
          metadata: {
            statistics: { totalBytesProcessed: String(bytes), query: { totalBytesBilled: String(bytes) } },
          },
          getQueryResults: async () => [fixture()],
        },
      ];
    },
  }) as unknown as BigQueryLike;
const base = (
  calls: Array<{ dryRun?: boolean; maximumBytesBilled?: string }>,
  bytes: number,
  ledger = new BudgetLedger(0),
) => ({
  bq: fakeBq(calls, bytes),
  archive: { archive: async () => ({ observation: { payloadObjectHash: "rawhash" } }) } as never,
  ch: null as unknown as ClickHouseClient,
  ledger,
  state: new AccountScanState("/nonexistent/accounts-state.json"),
  location: "us-east1",
  chunk: { id: "accounts:window", ...chunk },
  mappings,
  registryVersion: "v1",
  head: 100,
});

describe("billed runner guards (fake BigQuery)", () => {
  const GiB = 1024 ** 3;
  it("stops without creating a billed job when the dry run exceeds the owner-approved 40 GiB", async () => {
    const calls: Array<{ dryRun?: boolean }> = [];
    const out = await runAccountScan(base(calls, 40 * GiB + 1));
    expect(out.status).toBe("over_approval");
    expect(calls.filter((c) => !c.dryRun)).toHaveLength(0);
  });
  it("defers when the estimate does not fit the shared 95% daily quota guard; no billed job", async () => {
    const calls: Array<{ dryRun?: boolean }> = [];
    const out = await runAccountScan(base(calls, 35 * GiB, new BudgetLedger(DAILY_LIMIT_BYTES - 10 * GiB)));
    expect(out.status).toBe("budget");
    expect(calls.filter((c) => !c.dryRun)).toHaveLength(0);
  });
  it("caps the billed job at 1.1 x the dry-run estimate and checkpoints through a real load", async () => {
    // disposable database: never the live one
    const name = "nearesis_t_a13_a23tests";
    await ensureDatabase(name);
    const admin = createClient({
      url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
      username: "nearesis",
      password: "nearesis",
      database: name,
    });
    try {
      await admin.command({ query: "DROP TABLE IF EXISTS schema_migrations" });
      for (const t of [
        "account_daily_head",
        "account_daily_tail",
        "entity_daily_signers",
        "account_daily_new_returning",
        "account_cohort_week_retention",
        "account_head_profile",
        "source_coverage",
        "account_daily_activity",
      ])
        await admin.command({ query: `DROP TABLE IF EXISTS ${t}` });
      await migrateLive(admin);
      const calls: Array<{ dryRun?: boolean; maximumBytesBilled?: string }> = [];
      const o = base(calls, 1000);
      o.ch = admin;
      o.state = new AccountScanState(`/private/tmp/claude-501/accounts-state-${process.pid}.json`);
      o.chunk = { id: "accounts:window", from: "2025-11-10", to: "2025-11-12" };
      const out = await runAccountScan(o);
      expect(out.status).toBe("done");
      const billed = calls.filter((c) => !c.dryRun);
      expect(billed).toHaveLength(1);
      expect(billed[0]!.maximumBytesBilled).toBe("1100");
      // a second run never re-bills
      expect((await runAccountScan(o)).status).toBe("already_done");
      expect(calls.filter((c) => !c.dryRun)).toHaveLength(1);
      const cnt = async (t: string) =>
        String(
          (
            (await (
              await admin.query({ query: `SELECT count() AS c FROM ${t} FINAL`, format: "JSONEachRow" })
            ).json()) as Array<{ c: string | number }>
          )[0]!.c,
        );
      expect(await cnt("account_daily_head")).toBe("3");
      expect(await cnt("account_daily_tail")).toBe("2");
      expect(await cnt("entity_daily_signers")).toBe("2");
      expect(await cnt("account_daily_new_returning")).toBe("2");
      // coverage: one complete row per day per dataset
      const cov = (await (
        await admin.query({
          query:
            "SELECT dataset, countIf(state='complete') AS c FROM source_coverage FINAL GROUP BY dataset ORDER BY dataset",
          format: "JSONEachRow",
        })
      ).json()) as Array<{ dataset: string; c: string | number }>;
      expect(cov.map((x) => String(x.c))).toEqual(["2", "2", "2", "2"]);
      // reconciliation against an independently loaded account_daily_activity: exact match, then a seeded difference is reported exactly
      const act = (
        date: string,
        tx: number,
        txo: number,
        sig: number,
        sigo: number,
        sint: number,
        t1c: number,
        t1t: number,
        t5c: number,
        t5t: number,
        ti: number,
        tb: number,
      ) => ({
        block_date: date,
        tx_total: tx,
        tx_intents: ti,
        tx_bridge: tb,
        tx_organic: txo,
        signers_total: sig,
        signers_organic: sigo,
        signers_with_intents: sint,
        top1pct_signer_count: t1c,
        top5pct_signer_count: t5c,
        top1pct_organic_tx: t1t,
        top5pct_organic_tx: t5t,
        account_rule_version: 1,
        source_label: "LIVE",
        raw_object_hash: "x",
        fetched_at: "2026-11-13 09:00:00.000",
        version: 1,
      });
      await admin.insert({
        table: "account_daily_activity",
        values: [
          act("2025-11-10", 585, 485, 6, 5, 1, 1, 300, 1, 300, 100, 0),
          act("2025-11-11", 131, 131, 4, 4, 0, 1, 120, 1, 120, 0, 0),
        ],
        format: "JSONEachRow",
      });
      const ok = await reconcileScan(admin, "2025-11-10", "2025-11-12");
      expect(ok.differences).toEqual([]);
      expect(ok.daysCompared).toBe(2);
      expect(ok.headPlusTailEqualsOrganic).toMatchObject({ days: 2, mismatches: [] });
      await admin.insert({
        table: "account_daily_activity",
        values: [act("2025-11-11", 132, 132, 4, 4, 0, 1, 120, 1, 120, 0, 0)].map((x) => ({
          ...x,
          version: 2,
        })),
        format: "JSONEachRow",
      });
      const bad = await reconcileScan(admin, "2025-11-10", "2025-11-12");
      expect(bad.differences.map((x) => [x.day, x.field, x.existing, x.scan])).toEqual([
        ["2025-11-11", "tx_total", "132", "131"],
        ["2025-11-11", "tx_organic", "132", "131"],
      ]);
      expect(bad.headPlusTailEqualsOrganic.mismatches.map((x) => x.field)).toEqual(["head_tx+tail_tx"]);
    } finally {
      await admin.close();
    }
  }, 60_000);
  it("loadAccountScan refuses a broken result before inserting anything", async () => {
    const bad = fixture().filter((x) => x.kind !== "day_b");
    await expect(
      loadAccountScan(null as never, chunk, bad, P, { head: 100, registryVersion: "v1" }),
    ).rejects.toThrow();
  });
});
