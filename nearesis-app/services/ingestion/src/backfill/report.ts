import type { ClickHouseClient } from "@clickhouse/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mib } from "./bq-runner.ts";
import { RUNS_DIR } from "./env.ts";
import { planChunks } from "./plan.ts";
import type { StateStore } from "./state.ts";

export interface RunSummary {
  startedAtUTC: string;
  bigquery: Record<string, unknown> | null;
  explorer: object | null;
  price: object | null;
}

interface Cov {
  dataset: string;
  rows: number;
  minDay: string | null;
  maxDay: string | null;
  distinctDays: number;
}

async function q<T>(ch: ClickHouseClient, sql: string): Promise<T[]> {
  const rs = await ch.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
  });
  return (await rs.json()) as T[];
}

export async function coverage(ch: ClickHouseClient): Promise<Cov[]> {
  const specs: Array<[string, string]> = [
    ["near_daily_tx", "block_date"],
    ["contract_interactions", "block_date"],
    ["contract_interactions_below_threshold", "block_date"],
    ["intents_swaps", "created_day"],
    ["price_candles", "day"],
  ];
  const out: Cov[] = [];
  for (const [t, col] of specs) {
    const r = await q<{ n: string; lo: string | null; hi: string | null; d: string }>(
      ch,
      `SELECT count() AS n, toString(min(${col})) AS lo, toString(max(${col})) AS hi, uniqExact(${col}) AS d FROM ${t} FINAL`,
    );
    const x = r[0];
    const n = Number(x?.n ?? 0);
    out.push({
      dataset: t,
      rows: n,
      minDay: n ? (x?.lo ?? null) : null,
      maxDay: n ? (x?.hi ?? null) : null,
      distinctDays: Number(x?.d ?? 0),
    });
  }
  return out;
}

export async function writeRunReport(d: {
  ch: ClickHouseClient;
  store: StateStore;
  summary: RunSummary;
  dataDir: string;
  dir?: string;
}): Promise<{ md: string; json: string }> {
  const cov = await coverage(d.ch);
  const gaps = await q<{ provider_id: string; dataset: string; n: string; reasons: string[] }>(
    d.ch,
    "SELECT provider_id, dataset, count() AS n, groupUniqArray(reason_code) AS reasons FROM quality_gaps FINAL GROUP BY provider_id, dataset",
  );
  const all = planChunks();
  const doneChunks = Object.values(d.store.state.chunks).sort((a, b) => a.id.localeCompare(b.id));
  const pending = all.filter((c) => !d.store.isDone(c.id));
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const report = {
    generatedAtUTC: now.toISOString(),
    window: d.store.state.window,
    summary: d.summary,
    discovery: d.store.state.discovery,
    coverage: cov,
    qualityGaps: gaps,
    chunksDone: doneChunks,
    chunksPending: pending.map((c) => c.id),
    billedByQuotaDay: d.store.state.billedByQuotaDay,
    explorer: d.store.state.explorer,
    price: d.store.state.price,
  };
  const dir = d.dir ?? RUNS_DIR;
  mkdirSync(dir, { recursive: true });
  const json = join(dir, `BACKFILL-${stamp}.json`);
  const md = join(dir, `BACKFILL-${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  const bq = d.summary.bigquery as Record<string, number | string | unknown> | null;
  const lines: string[] = [
    `# Live backfill run ${stamp}`,
    "",
    `Window ${report.window.from} to ${report.window.to} (UTC, inclusive). All rows in database nearesis_live carry source_label LIVE.`,
    "",
    "## BigQuery",
    bq
      ? [
          `- Project / location (discovered at runtime): ${String((bq.discovery as { billingProject: string }).billingProject)} / ${String((bq.discovery as { datasetLocation: string }).datasetLocation)}; credential kind: ${String((bq.discovery as { credentialPrincipal: string | null }).credentialPrincipal)}`,
          `- Quota day start: ${String(bq.quotaDayStartUTC)}`,
          `- Billed before this run: ${mib(Number(bq.billedBeforeRunBytes))} MiB; after (INFORMATION_SCHEMA): ${mib(Number(bq.billedAfterRunBytesInformationSchema))} MiB; limit ${mib(Number(bq.limitBytes))} MiB`,
          `- Stop reason: ${String(bq.stopReason)}; chunks completed this run: ${(bq.completed as string[]).length}`,
        ].join("\n")
      : "- not run in this session",
    "",
    `Chunks done (${doneChunks.length} of ${all.length}):`,
    "",
    "| chunk | days | rows | estimate MiB | billed MiB | quota day |",
    "|---|---|---|---|---|---|",
    ...doneChunks.map(
      (c) =>
        `| ${c.id} | ${c.from}..${c.to} | ${c.rows} | ${mib(c.estimateBytes)} | ${mib(c.billedBytes)} | ${c.quotaDay} |`,
    ),
    "",
    `Chunks pending (${pending.length}): ${pending.map((c) => c.id).join(", ") || "none"}`,
    "",
    "## Coverage per dataset (ClickHouse nearesis_live)",
    "",
    "| dataset | rows | first day | last day | distinct days |",
    "|---|---|---|---|---|",
    ...cov.map(
      (c) => `| ${c.dataset} | ${c.rows} | ${c.minDay ?? "-"} | ${c.maxDay ?? "-"} | ${c.distinctDays} |`,
    ),
    "",
    "## Quality gaps recorded",
    "",
    gaps.length
      ? gaps.map((g) => `- ${g.provider_id}/${g.dataset}: ${g.n} gaps (${g.reasons.join(", ")})`).join("\n")
      : "- none recorded",
    "",
    "## Explorer (1Click swap history, read-only)",
    "",
    `- Cumulative: ${JSON.stringify(d.store.state.explorer)}`,
    `- This session: ${JSON.stringify(d.summary.explorer)}`,
    "",
    "## CoinGecko",
    "",
    `- State: ${JSON.stringify(d.store.state.price)}`,
    `- This session: ${JSON.stringify(d.summary.price)}`,
    "",
  ];
  writeFileSync(md, lines.join("\n"));
  return { md, json };
}
