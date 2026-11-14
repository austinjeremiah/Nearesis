import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAll, rawFileText, type JobRecord } from "./fees-build.ts";

const Y = 10n ** 24n;
const rec = (
  family: string,
  from: string,
  to: string,
  columns: string[],
  data: Array<Array<string | null>>,
): JobRecord => ({
  id: `${family}:${from}`,
  family,
  from,
  to,
  sql: `-- sql ${family}`,
  querySha256: "q",
  dryRunBytes: 100,
  bytesBilled: 200,
  jobId: `job_${family}_${from}`,
  location: "us-east1",
  executedAt: "2026-11-14T12:00:00.000Z",
  rows: data.length,
  columns,
  data,
  resultSha256: "r",
});
const OC = [
  "kind",
  "block_date",
  "account",
  "n",
  "gas",
  "tokens_yocto",
  "null_gas",
  "null_tokens",
  "fractional_gas",
  "day_rank",
];

describe("buildAll", () => {
  it("writes the series files, SQL records, manifest and notes from saved chunks", async () => {
    const root = mkdtempSync(join(tmpdir(), "fees-build-"));
    const chunks = join(root, "thesis", "raw", "fees", "chunks");
    mkdirSync(chunks, { recursive: true });
    const days = ["2026-11-12", "2026-11-13"];
    const out = rec("outcomes", "2026-11-12", "2026-11-14", OC, [
      ...days.map((d) => ["day", d, null, "100", "1000", (50n * Y).toString(), "0", "0", "0", null]),
      ...days.map((d) => ["ex", d, "intents.near", "10", "100", (5n * Y).toString(), "0", "0", "0", "3"]),
      ...days.map((d) => ["ex", d, "eth.omft.near", "4", "40", (2n * Y).toString(), "0", "0", "0", "8"]),
      ["top", null, "intents.near", "20", "200", (10n * Y).toString(), null, null, null, "1"],
    ]);
    const disc = rec(
      "discovery",
      "2026-11-12",
      "2026-11-12",
      ["executor_account_id", "tokens_yocto", "gas", "outcomes", "transactions", "rank"],
      [
        ["intents.near", (5n * Y).toString(), "100", "10", "5", "1"],
        ["eth.omft.near", (2n * Y).toString(), "40", "4", "4", "2"],
        ["__all_executors__", (8n * Y).toString(), "200", "20", null, null],
      ],
    );
    const blocks = rec(
      "blocks",
      "2026-11-12",
      "2026-11-14",
      ["block_date", "blocks", "min_gas_price", "max_gas_price", "sum_gas_price", "null_price_rows"],
      [["2026-11-12", "2", "100000000", "100000000", "200000000", "0"]],
    );
    const tx = rec(
      "tx",
      "2026-11-12",
      "2026-11-14",
      [
        "kind",
        "block_date",
        "account",
        "txs",
        "conversion_gas",
        "conversion_tokens_yocto",
        "null_gas",
        "null_tokens",
        "day_rank",
      ],
      [
        ["day", "2026-11-12", null, "30", "300", Y.toString(), "0", "0", null],
        ["rcv", "2026-11-12", "intents.near", "5", "50", (Y / 10n).toString(), "0", "0", "2"],
      ],
    );
    for (const r of [out, disc, blocks, tx])
      writeFileSync(join(chunks, `${r.family}_${r.from}_${r.to}.json`), JSON.stringify(r));
    const frozen = (rows: string[][]) =>
      `{"columns":[],"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
    writeFileSync(
      join(root, "thesis", "raw", "near_price_daily.json"),
      frozen([
        ["2026-11-12", "2"],
        ["2026-11-13", "3"],
      ]),
    );
    writeFileSync(join(root, "thesis", "raw", "intents_volume_daily.json"), frozen([["2026-11-12", "1000"]]));
    const { files } = await buildAll({ appRoot: root, skipCrossCheck: true });
    expect(files).toContain("raw/fees/manifest.json");
    const m = JSON.parse(readFileSync(join(root, "thesis", "raw", "fees", "manifest.json"), "utf8")) as {
      datasets: Array<Record<string, unknown>>;
    };
    const ids = m.datasets.map((d) => d.id);
    expect(ids).toEqual([
      "fees_total_daily",
      "fees_intents_daily",
      "fees_by_receiver_top",
      "tx_fee_intents_daily",
      "fees_take_rate_gas_daily",
      "fees_footprint_discovery",
    ]);
    const intents = m.datasets.find((d) => d.id === "fees_intents_daily") as {
      rows: number;
      bigQueryExecuted: boolean;
      coverage: { missingDays: string[] };
      sqlExecuted: string;
    };
    expect(intents.rows).toBe(2);
    expect(intents.bigQueryExecuted).toBe(true);
    expect(intents.coverage.missingDays).toHaveLength(367); // all but the 2 fetched days are listed, never zero-filled
    const take = JSON.parse(
      readFileSync(join(root, "thesis", "raw", "fees", "fees_take_rate_gas_daily.json"), "utf8"),
    ) as { rows: string[][] };
    // 5 NEAR x 2 USD / 1000 USD = 100 bps (narrow); wide adds 2 NEAR -> 7 x 2 / 1000 = 140 bps
    expect(take.rows[0]?.[5]).toBe("100.00000000");
    expect(take.rows[0]?.[6]).toBe("140.00000000");
    expect(take.rows[1]?.[5]).toBeNull(); // no volume on 2026-11-13
    expect(readFileSync(join(root, "thesis", "raw", "fees", "NOTES.md"), "utf8")).toMatch(/Headline numbers/);
    expect(readFileSync(join(root, "thesis", "sql", "executed", "fees_total_daily.sql"), "utf8")).toMatch(
      /jobId=job_outcomes/,
    );
    expect(rawFileText([{ name: "d", type: "date" }], [["x"]])).toBe(
      '{"columns":[{"name":"d","type":"date"}],"rows":[\n["x"]\n]}\n',
    );
  });
});
