import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureText } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExplorerFixtureServer, type FakeResponse } from "../../src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

const envs: TestEnv[] = [];
beforeAll(async () => {
  for (let i = 0; i < 3; i++) envs.push(await setupEnv());
}, 60_000);
afterAll(async () => {
  await Promise.all(envs.map((e) => e.close()));
}, 60_000);

const BAD = "fx.explorer.bad-body";

// D06: Bad JSON / body checksum -> quarantine and trace event, no fact promotion
it("quarantines bad JSON, schema-invalid bodies and checksum mismatches without promoting facts", async () => {
  const pages = loadPages("fx.explorer.pages-3");
  const cases: Array<{ name: string; reason: string; res: FakeResponse }> = [
    {
      name: "bad-json",
      reason: "BAD_JSON",
      res: { status: 200, body: readFixtureText(BAD, "bad-json.txt") },
    },
    {
      name: "bad-schema",
      reason: "BAD_SCHEMA",
      res: { status: 200, body: readFixtureText(BAD, "bad-schema.json") },
    },
    {
      name: "checksum-mismatch",
      reason: "CHECKSUM_MISMATCH",
      res: {
        status: 200,
        headers: { "x-body-sha256": readFixtureText(BAD, "checksum-mismatch.sha256").trim() },
        body: readFixtureText(BAD, "checksum-mismatch.json"),
      },
    },
  ];
  const outcomes: Array<Record<string, unknown>> = [];
  for (const [i, k] of cases.entries()) {
    const env = envs[i]!;
    const server = new ExplorerFixtureServer(env.clock, pages);
    const c = env.collector(server.fetchImpl);
    await c.run({ maxPages: 1 }); // page 1 is good: 5 facts
    server.intercept((r) => (r.query.lastDepositAddress ? k.res : undefined));
    const r = await c.run();
    expect(r.status).toBe("quarantined");
    expect(r.quarantineReason).toBe(k.reason);

    const q = await env.tdb.db.query<{ reason_code: string; raw_object_hash: string; kind: string }>(
      "SELECT reason_code, raw_object_hash, kind FROM ingestion.quarantine",
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]).toMatchObject({ reason_code: k.reason, kind: "explorer_page" });
    expect(await env.store.has(q.rows[0]!.raw_object_hash)).toBe(true); // evidence retained
    const tr = await env.tdb.db.query(
      "SELECT 1 FROM ingestion.trace_events WHERE kind='explorer.quarantine' AND detail->>'reason_code'=$1",
      [k.reason],
    );
    expect(tr.rowCount).toBe(1);
    const facts = await env.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps");
    expect(Number(facts.rows[0]?.n)).toBe(5); // only the good first page
    const cp = await c.checkpoint();
    expect(cp.pagesCommitted).toBe(1); // cursor not advanced past the bad page
    const h = await c.health();
    expect(h.health).toBe("degraded");
    outcomes.push({
      case: k.name,
      reason: k.reason,
      quarantineRows: q.rows.length,
      traceEvents: tr.rowCount,
      factsPromoted: Number(facts.rows[0]?.n) - 5,
    });
  }
  observe({
    testId: "D06",
    observed: `3 bad-body cases (bad JSON, schema-invalid, checksum mismatch): each produced 1 quarantine row + 1 trace event, 0 facts promoted from the bad page (5 facts from good page 1 only), cursor stayed at page 1, source degraded`,
    fixtureHash: fixtureHash(BAD),
    evidence: { outcomes },
  });
}, 120_000);
