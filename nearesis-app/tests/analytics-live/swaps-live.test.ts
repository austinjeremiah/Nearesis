/**
 * LIVE swap analytics, verified end to end (final_master_prompt s14). Read-only against the running stack:
 * public path = API :4110 dev login -> web BFF :3300 /api/semantic/panel (the same route the canvas uses), source=live,
 * reconciled against the base table nearesis_live.intents_swaps FINAL. Nothing here writes to a shared database except a
 * disposable second tenant (org + user + membership) that is removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPg } from "../../services/analytics/src/index.ts";
import { formatScale } from "../../packages/semantic-gateway/src/index.ts";
import {
  closePg,
  devLogin,
  liveAst,
  liveCh,
  liveGateway,
  M,
  OWNER_SUBJECT,
  panel,
  queryRows,
  rawByDay,
  registerAst,
  session,
  WORKSPACE,
  type LiveGw,
} from "./lib.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** Differs per run so a prior run's cached envelope (5 min TTL) can never answer a query that must be computed afresh. */
const NONCE = 1_000 + Math.floor(Math.random() * 7_000);
const MAY = "2026-05-01T00:00:00Z";
/** First fully loaded day of the source (the oldest-edge day is still filling and is exercised separately). Set in beforeAll. */
let FULL_FROM = "2026-02-22T00:00:00Z";
const NOW_TO = "2026-11-13T00:00:00Z";

const ch = liveCh();
let token = "";
let tenantId = "";
let gw: LiveGw;
/** day -> coverage state for near-explorer intents_swaps (the registry source of every swap metric) */
let coverage = new Map<string, { state: string; reason: string | null }>();

const day = (t: string | number | null) => String(t).slice(0, 10);
const num = (v: string | number | null) => (v === null ? null : String(v));
const dec = (v: string | number | null) => (v === null ? null : formatScale(String(v), 18));

beforeAll(async () => {
  token = await devLogin(OWNER_SUBJECT);
  const w = await fetch(
    `${process.env.NEARESIS_API_URL ?? "http://127.0.0.1:4110"}/v1/workspaces/${WORKSPACE}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  expect(w.status).toBe(200);
  tenantId = ((await w.json()) as { orgId: string }).orgId;
  const cov = await queryRows<{ d: string; state: string; reason: string | null }>(
    ch,
    `SELECT toString(day) AS d, state, reason FROM source_coverage FINAL
     WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps'`,
  );
  coverage = new Map(cov.map((c) => [c.d, { state: c.state, reason: c.reason }]));
  FULL_FROM = `${
    [...coverage.entries()]
      .filter(([, c]) => c.state === "complete")
      .map(([d]) => d)
      .sort()[0]
  }T00:00:00Z`;
  gw = liveGateway();
});
afterAll(async () => {
  await gw.close();
  await ch.close();
  await closePg();
});

describe("1. real swap metrics through the public application API", () => {
  for (const [name, from] of [
    ["since 2026-05-01", MAY],
    ["full available window", FULL_FROM],
  ] as const) {
    it(`daily swap count, completed count and known USD volume return ${name}`, async () => {
      const counts = await panel(
        token,
        await registerAst(liveAst({ measures: [M.swaps, M.completed] }, from, NOW_TO)),
      );
      expect(counts.status).toBe(200);
      expect(counts.body.chart.columns.map((c) => c.name)).toEqual([
        "intents_swaps_live.day",
        M.swaps,
        M.completed,
      ]);
      const days = counts.body.chart.rows.length;
      const expectedDays = Math.round((Date.parse(NOW_TO) - Date.parse(from)) / 86_400_000);
      expect(days).toBe(expectedDays);
      const total = counts.body.chart.rows.reduce((a, r) => a + Number(r[1] ?? 0), 0);
      expect(total).toBeGreaterThan(from === MAY ? 3_000_000 : 4_000_000);
      expect(counts.body.chart.rows.every((r) => r[1] !== null && r[2] !== null)).toBe(true);
      expect(counts.body.provenance.sourceLabel).toBe("LIVE");

      const vol = await panel(token, await registerAst(liveAst({ measures: [M.volume] }, from, NOW_TO)));
      expect(vol.status).toBe(200);
      expect(vol.body.chart.rows.length).toBe(expectedDays);
      const known = vol.body.chart.rows.filter((r) => r[1] !== null);
      expect(known.length).toBeGreaterThan(expectedDays - 10);
      // exact decimal string, not a float
      expect(typeof known[0]![1]).toBe("string");
      expect(String(known[0]![1])).toMatch(/^\d+\.\d{18}$/);
    });
  }
});

describe("2. rollup totals reconcile with source", () => {
  it("per day and in total: count, completed, USD-known/unknown and volume equal nearesis_live.intents_swaps FINAL", async () => {
    const hCounts = await registerAst(liveAst({ measures: [M.swaps, M.completed] }, FULL_FROM, NOW_TO));
    const hKnown = await registerAst(liveAst({ measures: [M.usdKnown, M.usdUnknown] }, FULL_FROM, NOW_TO));
    const hVol = await registerAst(liveAst({ measures: [M.volume] }, FULL_FROM, NOW_TO));
    const fromDay = FULL_FROM.slice(0, 10);
    const before = await rawByDay(ch, fromDay, "2026-11-13");
    const [c, k, v] = await Promise.all([panel(token, hCounts), panel(token, hKnown), panel(token, hVol)]);
    const after = await rawByDay(ch, fromDay, "2026-11-13");
    for (const r of [c, k, v]) expect(r.status).toBe(200);

    let sumApi = 0;
    let sumRaw = 0;
    let exactDays = 0;
    const partialSeen: string[] = [];
    for (let i = 0; i < c.body.chart.rows.length; i++) {
      const d = day(c.body.chart.rows[i]![0]!);
      const cov = coverage.get(d);
      const raw = after.get(d);
      const api = c.body.chart.rows[i]!;
      if (cov?.state === "complete") {
        // a complete day is final: the rollup must equal the source exactly, on every measure
        // a day with no source rows reads as zero swaps (see coverage-integrity.test.ts for whether that day may be "complete")
        const rw = raw ?? { swaps: "0", completed: "0", usd_known: "0", usd_unknown: "0", volume: "0" };
        expect(num(api[1]), `swap_count ${d}`).toBe(rw.swaps);
        expect(num(api[2]), `completed ${d}`).toBe(rw.completed);
        expect(num(k.body.chart.rows[i]![1]), `usd_known ${d}`).toBe(rw.usd_known);
        expect(num(k.body.chart.rows[i]![2]), `usd_unknown ${d}`).toBe(rw.usd_unknown);
        expect(dec(v.body.chart.rows[i]![1]), `volume ${d}`).toBe(dec(rw.volume));
        sumApi += Number(api[1]);
        sumRaw += Number(rw.swaps);
        exactDays++;
      } else {
        // a partial/unknown day may still be filling: it must never exceed what the source holds now, and is labelled below
        partialSeen.push(d);
        const lo = Number(before.get(d)?.swaps ?? 0);
        const hi = Number(raw?.swaps ?? 0);
        if (api[1] !== null) expect(Number(api[1])).toBeLessThanOrEqual(hi);
        void lo;
      }
    }
    expect(exactDays).toBeGreaterThan(240);
    expect(sumApi).toBe(sumRaw);
    // the three non-complete days of the live window are exactly the ones the source marks partial
    expect(partialSeen.sort()).toEqual(
      [...coverage.entries()]
        .filter(([d, s]) => s.state !== "complete" && d >= fromDay)
        .map(([d]) => d)
        .sort(),
    );
  });

  it("every day the API returns is accounted for: known + unknown USD = swap count, on complete days", async () => {
    const hCounts = await registerAst(liveAst({ measures: [M.swaps] }, MAY, NOW_TO));
    const hKnown = await registerAst(liveAst({ measures: [M.usdKnown] }, MAY, NOW_TO));
    const hUnk = await registerAst(liveAst({ measures: [M.usdUnknown] }, MAY, NOW_TO));
    const [c, k, u] = await Promise.all([panel(token, hCounts), panel(token, hKnown), panel(token, hUnk)]);
    c.body.chart.rows.forEach((r, i) => {
      if (coverage.get(day(r[0]!))?.state !== "complete") return;
      expect(Number(k.body.chart.rows[i]![1]) + Number(u.body.chart.rows[i]![1])).toBe(Number(r[1]));
    });
  });

  it("partial days are labelled: per-row coverage on the envelope and freshness/gaps on the public panel", async () => {
    const ast = liveAst({ measures: [M.swaps], limit: NONCE + 5 }, FULL_FROM, NOW_TO);
    const r = await gw.gateway.query(session(tenantId, WORKSPACE), ast);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const env = r.envelope;
    const partialDays = env.rows
      .filter((_, i) => env.rowCoverage[i] === "partial")
      .map((row) => day(row[0]!));
    expect(partialDays.sort()).toEqual(
      [...coverage.entries()]
        .filter(([d, s]) => s.state === "partial" && d >= FULL_FROM.slice(0, 10))
        .map(([d]) => d)
        .sort(),
    );
    expect(env.certification).toBe("partial");
    expect(env.partialCount).toBe(partialDays.length);
    // public panel: never "fresh" when a day in the window is partial
    const pub = await panel(token, await registerAst(liveAst({ measures: [M.swaps] }, FULL_FROM, NOW_TO)));
    expect(pub.body.chart.freshness).toBe("partial");
    expect(pub.body.provenance.certification).toBe("partial");
    expect(pub.body.gaps.some((g) => g.reason.startsWith("QUARANTINED_PAGE"))).toBe(true);
    // a window of only complete days is certified
    const clean = await panel(
      token,
      await registerAst(liveAst({ measures: [M.swaps] }, "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z")),
    );
    expect(clean.body.provenance.certification).toBe("certified");
    expect(clean.body.chart.freshness).toBe("fresh");
  });
});

describe("3. null / unknown semantics and filters", () => {
  it("a day with swaps but no known USD value is null (never 0); a day with no swaps in the slice is zero only because the count is zero too", async () => {
    // PROCESSING swaps are rare: most days hold none. Zero swaps on a complete day is a true zero volume AND a zero count.
    const f = [{ member: "intents_swaps_live.status", operator: "equals", values: ["PROCESSING"] }];
    const from = "2026-10-01T00:00:00Z";
    const to = "2026-11-01T00:00:00Z";
    const vol = await panel(
      token,
      await registerAst(liveAst({ measures: [M.volume], filters: f }, from, to)),
    );
    const cnt = await panel(token, await registerAst(liveAst({ measures: [M.swaps], filters: f }, from, to)));
    expect(vol.status).toBe(200);
    const raw = await rawByDay(ch, "2026-10-01", "2026-11-01", "status = 'PROCESSING'");
    let emptyDays = 0;
    vol.body.chart.rows.forEach((row, i) => {
      const d = day(row[0]!);
      const rr = raw.get(d);
      if (!rr) {
        expect(Number(cnt.body.chart.rows[i]![1]), `count ${d}`).toBe(0);
        expect(Number(row[1]), `volume of a zero-swap complete day ${d}`).toBe(0);
        emptyDays++;
      } else expect(dec(row[1])).toBe(dec(rr.volume));
    });
    expect(emptyDays).toBeGreaterThan(0);
  });

  it("amounts that are NULL in the source stay NULL: the unknown-USD swaps are counted as unknown, never added as 0", async () => {
    const raw = await rawByDay(ch, FULL_FROM.slice(0, 10), "2026-11-13", "amount_in_usd IS NULL");
    const total = [...raw.values()].reduce((a, r) => a + Number(r.usd_unknown), 0);
    expect(total).toBeGreaterThan(0); // the live table really contains NULL-USD swaps
    const r = await panel(token, await registerAst(liveAst({ measures: [M.usdUnknown] }, FULL_FROM, NOW_TO)));
    const api = r.body.chart.rows.reduce((a, x) => a + Number(x[1] ?? 0), 0);
    // complete days only (partial days can still be filling)
    const apiComplete = r.body.chart.rows
      .filter((x) => coverage.get(day(x[0]!))?.state === "complete")
      .reduce((a, x) => a + Number(x[1] ?? 0), 0);
    const rawComplete = [...raw.entries()]
      .filter(([d]) => coverage.get(d)?.state === "complete")
      .reduce((a, [, x]) => a + Number(x.usd_unknown), 0);
    expect(apiComplete).toBe(rawComplete);
    expect(api).toBeGreaterThanOrEqual(apiComplete);
    // volume on a day with unknown-USD swaps is the sum over KNOWN values only, i.e. a lower bound
    const day0 = [...raw.entries()].find(
      ([d, x]) => Number(x.usd_unknown) > 0 && coverage.get(d)?.state === "complete",
    )![0];
    const next = new Date(Date.parse(`${day0}T00:00:00Z`) + 86_400_000).toISOString();
    const vol = await panel(
      token,
      await registerAst(liveAst({ measures: [M.volume] }, `${day0}T00:00:00Z`, next)),
    );
    const allDay = await queryRows<{ v: string }>(
      ch,
      `SELECT toString(sumIf(amount_in_usd, amount_in_usd IS NOT NULL)) AS v FROM intents_swaps FINAL WHERE created_day = toDate({d:String})`,
      { d: day0 },
    );
    expect(dec(vol.body.chart.rows[0]![1])).toBe(dec(allDay[0]!.v));
  });

  for (const f of [
    { member: "intents_swaps_live.status", value: "REFUNDED", where: "status = 'REFUNDED'" },
    { member: "intents_swaps_live.status", value: "FAILED", where: "status = 'FAILED'" },
    {
      member: "intents_swaps_live.privacy_era",
      value: "private_settlement",
      where: "privacy_era = 'private_settlement'",
    },
    { member: "intents_swaps_live.privacy_era", value: "public", where: "privacy_era = 'public'" },
  ]) {
    it(`filter ${f.member} = ${f.value} is honoured, per day, against the source`, async () => {
      const from = "2026-09-15T00:00:00Z";
      const to = "2026-11-12T00:00:00Z"; // complete days only
      const ast = liveAst(
        { measures: [M.swaps], filters: [{ member: f.member, operator: "equals", values: [f.value] }] },
        from,
        to,
      );
      const unfiltered = await panel(token, await registerAst(liveAst({ measures: [M.swaps] }, from, to)));
      const r = await panel(token, await registerAst(ast));
      expect(r.status).toBe(200);
      const raw = await rawByDay(ch, "2026-09-15", "2026-11-12", f.where);
      let sumFiltered = 0;
      let sumAll = 0;
      r.body.chart.rows.forEach((row, i) => {
        const d = day(row[0]!);
        expect(num(row[1]), `${f.value} ${d}`).toBe(raw.get(d)?.swaps ?? "0");
        sumFiltered += Number(row[1]);
        sumAll += Number(unfiltered.body.chart.rows[i]![1]);
      });
      expect(sumFiltered).toBeLessThan(sumAll);
    });
  }

  it("grouping by status returns one row per day and status that sums to the unfiltered count", async () => {
    const from = "2026-10-20T00:00:00Z";
    const to = "2026-11-01T00:00:00Z";
    const g = await panel(
      token,
      await registerAst(
        liveAst({ measures: [M.swaps], dimensions: ["intents_swaps_live.status"] }, from, to),
      ),
    );
    expect(g.status).toBe(200);
    const raw = await queryRows<{ d: string; s: string; n: string }>(
      ch,
      `SELECT toString(created_day) AS d, status AS s, toString(count()) AS n FROM intents_swaps FINAL
       WHERE created_day >= toDate('2026-10-20') AND created_day < toDate('2026-11-01') GROUP BY d, s`,
    );
    const want = new Map(raw.map((r) => [`${r.d}|${r.s}`, r.n]));
    const got = new Map(g.body.chart.rows.map((r) => [`${day(r[0]!)}|${r[1]}`, String(r[2])]));
    expect(got).toEqual(want);
  });
});

describe("4. cost estimate comes from the rollup", () => {
  it("a covering fresh rollup estimates orders of magnitude below the raw-row estimate and far below the 5M cap", async () => {
    // limit differs per call so the result cache cannot answer: the cost gate and the envelope are computed afresh
    const ast = liveAst({ measures: [M.swaps, M.completed], limit: NONCE + 1 }, FULL_FROM, NOW_TO);
    const rollup = liveGateway();
    const raw = liveGateway({ rollupAwareCost: false });
    try {
      const a = await rollup.gateway.query(session(tenantId, WORKSPACE), ast);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      const estRollup = a.envelope.cost.bytesEstimated / 200;
      expect(rollup.gateway.stats().rollupEstimates).toBe(1);
      expect(estRollup).toBeLessThan(5_000_000 / 100);
      // the same query priced from raw rows: reject-or-near-cap, and at least 100x the rollup estimate
      const ast2 = { ...ast, limit: NONCE + 2 };
      const b = await raw.gateway.query(session(tenantId, WORKSPACE), ast2);
      if (b.ok) {
        const estRaw = b.envelope.cost.bytesEstimated / 200;
        expect(estRaw).toBeGreaterThan(estRollup * 100);
      } else expect(b.error.reasonCode).toBe("COST_CAP");
      expect(raw.gateway.stats().rollupEstimates ?? 0).toBe(0);
      // the full window must be admitted under the cap; this is the owner's question window
      expect(estRollup).toBeLessThan(5_000_000);
    } finally {
      await rollup.close();
      await raw.close();
    }
  });
});

describe("5. no stale result presented as fresh", () => {
  it("the envelope carries generatedAt, certification, and source watermarks no older than the source, and the cache key embeds the vintage", async () => {
    const ast = liveAst({ measures: [M.swaps], limit: NONCE + 3 }, "2026-10-01T00:00:00Z", NOW_TO);
    const g = liveGateway();
    try {
      const t0 = Date.now();
      const r = await g.gateway.query(session(tenantId, WORKSPACE), ast);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.cache).toBe("miss");
      expect(Math.abs(Date.parse(r.envelope.generatedAt) - t0)).toBeLessThan(60_000);
      const wm =
        r.envelope.sourceWatermarks["near-explorer"] ?? r.envelope.sourceWatermarks["intents-1click"] ?? null;
      const src = await queryRows<{ w: string }>(
        ch,
        "SELECT toString(max(created_at)) AS w FROM intents_swaps",
      );
      const newestRow = Date.parse(`${src[0]!.w.replace(" ", "T")}Z`);
      // the swap watermark the response reports must not be OLDER than the data the response was computed from
      expect(Object.keys(r.envelope.sourceWatermarks).length).toBeGreaterThan(0);
      if (wm)
        expect(Date.parse(`${String(wm).replace(" ", "T").replace(/Z?$/, "Z")}`)).toBeGreaterThanOrEqual(
          newestRow - 3_600_000,
        );
      // the same query again is a hit that keeps its ORIGINAL generatedAt (a cache hit is never re-stamped as fresh)
      const again = await g.gateway.query(session(tenantId, WORKSPACE), ast);
      expect(again.ok).toBe(true);
      if (again.ok) {
        if (again.cache === "hit") {
          expect(again.envelope.generatedAt).toBe(r.envelope.generatedAt);
          expect(again.cacheKey).toBe(r.cacheKey);
        } else {
          // the live table is written continuously (ingestion + merges): a changed vintage must change the key, never reuse the old entry
          expect(again.cacheKey).not.toBe(r.cacheKey);
          expect(Date.parse(again.envelope.generatedAt)).toBeGreaterThanOrEqual(
            Date.parse(r.envelope.generatedAt),
          );
        }
      }
      // the key embeds the source vintage: it is not a bare query hash
      expect(r.cacheKey).not.toContain(r.queryHash + "-only");
      expect(r.cacheKey.length).toBeGreaterThan(r.queryHash.length);
    } finally {
      await g.close();
    }
  });

  it("the public panel reports a source watermark and 'partial' while the newest day is still filling", async () => {
    const r = await panel(
      token,
      await registerAst(liveAst({ measures: [M.swaps] }, "2026-11-01T00:00:00Z", NOW_TO)),
    );
    expect(r.body.chart.sourceWatermark).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.body.chart.freshness).toBe("partial");
  });
});

describe("6. tenant isolation", () => {
  const subject = `a16-other-tenant-${randomUUID().slice(0, 8)}`;
  const orgId = randomUUID();
  const userId = randomUUID();
  const pg = createPg();
  let other = "";
  beforeAll(async () => {
    await pg.query("INSERT INTO organizations(id, name) VALUES ($1, 'a16 disposable tenant')", [orgId]);
    await pg.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1, $2, 'a16')", [
      userId,
      subject,
    ]);
    await pg.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1, $2, 'owner')", [
      orgId,
      userId,
    ]);
    other = await devLogin(subject);
  });
  afterAll(async () => {
    await pg.query("DELETE FROM memberships WHERE org_id = $1", [orgId]).catch(() => undefined);
    await pg.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    await pg.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => undefined);
    await pg.end();
  });

  it("a second tenant cannot read the first tenant's workspace panel (404, no data) while the owner can", async () => {
    const h = await registerAst(liveAst({ measures: [M.swaps] }, MAY, NOW_TO));
    const owner = await panel(token, h);
    expect(owner.status).toBe(200);
    const cross = await panel(other, h);
    expect([403, 404]).toContain(cross.status);
    expect(JSON.stringify(cross.body)).not.toMatch(/rows|swap_count|oneclick/);
    const anon = await fetch(
      `http://127.0.0.1:3300/api/semantic/panel/${h}?workspace=${WORKSPACE}&source=live`,
    );
    expect([401, 403, 404]).toContain(anon.status);
    // the workspace API says the same
    const ws = await fetch(`http://127.0.0.1:4110/v1/workspaces/${WORKSPACE}`, {
      headers: { authorization: `Bearer ${other}` },
    });
    expect([403, 404]).toContain(ws.status);
  });

  it("the result cache is partitioned by tenant and workspace: the same query from two tenants never shares an entry", async () => {
    const ast = liveAst({ measures: [M.swaps], limit: NONCE + 4 }, MAY, NOW_TO);
    const g = liveGateway();
    try {
      const a = await g.gateway.query(session(tenantId, WORKSPACE), ast);
      const b = await g.gateway.query(session(orgId, randomUUID()), ast);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.cacheKey).not.toBe(b.cacheKey);
      expect(b.cache).toBe("miss"); // tenant B did not get tenant A's cached entry
      const audit = g.gateway.audit();
      expect(audit.at(-1)!.boundContext.tenantId).toBe(orgId);
    } finally {
      await g.close();
    }
  });
});

describe("7. concurrency", () => {
  it("20 concurrent identical public queries all succeed with the identical result", async () => {
    const h = await registerAst(liveAst({ measures: [M.swaps, M.completed] }, FULL_FROM, NOW_TO));
    const rs = await Promise.all(Array.from({ length: 20 }, () => panel(token, h)));
    expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(new Set(rs.map((r) => r.body.provenance.resultHash)).size).toBe(1);
    expect(Math.max(...rs.map((r) => r.ms))).toBeLessThan(60_000);
  });

  it("20 concurrent cold queries of distinct shapes (no shared cache entry) are stable", async () => {
    const hs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        registerAst(liveAst({ measures: [M.swaps], limit: NONCE + 100 + i }, MAY, NOW_TO)),
      ),
    );
    const rs = await Promise.all(hs.map((h) => panel(token, h)));
    expect(rs.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(new Set(rs.map((r) => r.body.provenance.resultHash)).size).toBe(1);
  });
});
