import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { expect, it } from "vitest";
import { createBigQueryClient } from "../../src/adapters/bigquery-client.ts";
import { RawArchive } from "../../src/archive/archive.ts";
import { FsObjectStore } from "../../src/archive/object-store.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "../../src/backfill/budget.ts";
import { BudgetedBigQuery } from "../../src/backfill/bq-runner.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "../../src/backfill/ch.ts";
import { makeChSink, runBigQueryPhase } from "../../src/backfill/orchestrator.ts";
import { quotaDayStart } from "../../src/backfill/plan.ts";
import { StateStore } from "../../src/backfill/state.ts";
import { tempName } from "../../src/backfill/env.ts";

/** One real single-day chunk inside the budget. Opt in with LIVE_BACKFILL=1 (it bills about 30 MiB). */
it.skipIf(process.env.LIVE_BACKFILL !== "1")(
  "runs a real one-day transactions chunk within the daily budget and loads it as LIVE",
  async () => {
    const db = tempName();
    await ensureDatabase(db);
    const ch = createLiveCh(db);
    const dir = mkdtempSync(join(tmpdir(), "backfill-live-"));
    try {
      await migrateLive(ch);
      const runner = new BudgetedBigQuery(
        createBigQueryClient(),
        new RawArchive(new FsObjectStore(join(dir, "raw")), null),
      );
      const disc = await runner.discover(null);
      const since = quotaDayStart(Date.now());
      const reading = await runner.billedSince(disc.datasetLocation, since.toISOString());
      const ledger = new BudgetLedger(reading.bytes);
      expect(ledger.remaining).toBeGreaterThan(0);
      const store = new StateStore(join(dir, "state.json"), "2026-11-05", "2026-11-05");
      const res = await runBigQueryPhase({
        runner,
        store,
        ledger,
        location: disc.datasetLocation,
        sink: makeChSink(ch),
        chunks: [
          { id: "transactions:2026-11-05", family: "transactions", from: "2026-11-05", to: "2026-11-06" },
        ],
        nowMs: () => Date.now(),
      });
      expect(res.completed).toEqual(["transactions:2026-11-05"]);
      const done = store.state.chunks["transactions:2026-11-05"]!;
      expect(done.billedBytes).toBeLessThanOrEqual(Math.ceil((done.estimateBytes * 11) / 10));
      expect(ledger.billedToday).toBeLessThanOrEqual(DAILY_LIMIT_BYTES);
      const rs = await ch.query({
        query: "SELECT block_date, tx_count, distinct_signer_proxy, source_label FROM near_daily_tx FINAL",
        format: "JSONEachRow",
        clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
      });
      const rows = (await rs.json()) as Array<Record<string, string>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ block_date: "2026-11-05", source_label: "LIVE" });
      expect(Number(rows[0]!.tx_count)).toBeGreaterThan(Number(rows[0]!.distinct_signer_proxy));
      expect(Number(rows[0]!.distinct_signer_proxy)).toBeGreaterThan(0);
    } finally {
      await ch.close();
      rmSync(dir, { recursive: true, force: true });
      const admin = createClient({
        url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
        username: process.env.NEARESIS_CH_USER ?? "nearesis",
        password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
        database: "default",
      });
      await admin.command({ query: `DROP DATABASE IF EXISTS ${db} SYNC` });
      await admin.close();
    }
  },
  120_000,
);
