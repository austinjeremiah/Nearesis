import { createHash, randomBytes } from "node:crypto";
import type { PanelSpec } from "@nearesis/contracts";
import type { PanelExecutor, PanelPin } from "../../src/history/pinned.ts";

/**
 * Real ClickHouse-backed panel executor for the history acceptance tests. It creates a disposable database
 * (nearesis_t_w2_<random>), never touches the `nearesis` database, and runs genuine SQL for every panel.
 */
const URL_ = process.env.CLICKHOUSE_HTTP_URL ?? "http://127.0.0.1:58123";
const AUTH =
  "Basic " +
  Buffer.from(
    `${process.env.CLICKHOUSE_USER ?? "nearesis"}:${process.env.CLICKHOUSE_PASSWORD ?? "nearesis"}`,
  ).toString("base64");

export const qhash = (name: string): string => createHash("sha256").update(`fx.query.${name}`).digest("hex");

async function ch(sql: string, db?: string): Promise<string> {
  const r = await fetch(`${URL_}/${db ? `?database=${db}` : ""}`, {
    method: "POST",
    headers: { Authorization: AUTH },
    body: sql,
    signal: AbortSignal.timeout(15_000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`clickhouse ${r.status}: ${t.slice(0, 300)}`);
  return t;
}

export async function clickhouseUp(): Promise<boolean> {
  try {
    const r = await fetch(`${URL_}/ping`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

interface QueryDef {
  source: string;
  metric: string;
  sql: (db: string, pin: PanelPin) => Promise<string>;
}

export class ChFixture implements PanelExecutor {
  readonly db = `nearesis_t_w2_${randomBytes(4).toString("hex")}`;
  readonly queries: Record<string, QueryDef>;

  constructor() {
    const wm = (pin: PanelPin, src: string) =>
      pin.watermark ? `AND ts <= toDateTime('${pin.watermark[src]!.replace("T", " ").slice(0, 19)}')` : "";
    const ver = (pin: PanelPin, m: string) => pin.semanticVersions[m] ?? "1.0.0";
    const washFilter = (pin: PanelPin) => (ver(pin, "dex_volume").startsWith("2") ? "AND wash = 0" : "");
    const exclude = async (db: string, pin: PanelPin) => {
      const pct = Number(pin.exclusions?.topAccountsPercent ?? 0);
      if (!pct) return "";
      const n = Number(
        (await ch(`SELECT uniqExact(account) FROM ${db}.dex_events FORMAT TabSeparated`)).trim(),
      );
      const k = Math.max(1, Math.ceil((n * pct) / 100));
      return `AND account NOT IN (SELECT account FROM ${db}.dex_events GROUP BY account ORDER BY sum(vol) DESC LIMIT ${k})`;
    };
    this.queries = {
      [qhash("dex_total")]: {
        source: "fx_dex",
        metric: "dex_volume",
        sql: async (db, pin) =>
          `SELECT round(sum(vol), 4) AS total, count() AS n FROM ${db}.dex_events WHERE 1 ${wm(pin, "fx_dex")} ${washFilter(pin)} ${await exclude(db, pin)} FORMAT JSONEachRow`,
      },
      [qhash("dex_accounts")]: {
        source: "fx_dex",
        metric: "dex_accounts",
        sql: async (db, pin) =>
          `SELECT uniqExact(account) AS accounts FROM ${db}.dex_events WHERE 1 ${wm(pin, "fx_dex")} ${await exclude(db, pin)} FORMAT JSONEachRow`,
      },
      [qhash("bridge_total")]: {
        source: "fx_bridge",
        metric: "bridge_volume",
        sql: async (db, pin) =>
          `SELECT round(sum(vol), 4) AS total FROM ${db}.bridge_events WHERE 1 ${wm(pin, "fx_bridge")} FORMAT JSONEachRow`,
      },
      [qhash("dex_daily")]: {
        source: "fx_dex",
        metric: "dex_volume",
        sql: async (db, pin) =>
          `SELECT toString(toDate(ts)) AS day, round(sum(vol), 4) AS v FROM ${db}.dex_events WHERE 1 ${wm(pin, "fx_dex")} ${washFilter(pin)} ${await exclude(db, pin)} GROUP BY day ORDER BY day FORMAT JSONEachRow`,
      },
    };
  }

  async setup(): Promise<void> {
    await ch(`CREATE DATABASE ${this.db}`);
    await ch(
      `CREATE TABLE ${this.db}.dex_events (ts DateTime, account String, vol Float64, wash UInt8) ENGINE = MergeTree ORDER BY ts`,
    );
    await ch(
      `CREATE TABLE ${this.db}.bridge_events (ts DateTime, vol Float64) ENGINE = MergeTree ORDER BY ts`,
    );
    const rows: string[] = [];
    for (let i = 0; i < 200; i++) {
      const day = 1 + (i % 9);
      const vol = 10 + ((i * 37) % 91);
      rows.push(`('2026-11-0${day} 10:00:00','acct${i % 40}',${vol},${i % 13 === 0 ? 1 : 0})`);
    }
    await ch(`INSERT INTO ${this.db}.dex_events VALUES ${rows.join(",")}`);
    await ch(
      `INSERT INTO ${this.db}.bridge_events VALUES ${Array.from({ length: 30 }, (_, i) => `('2026-11-0${1 + (i % 9)} 12:00:00',${5 + i})`).join(",")}`,
    );
  }

  /** A later data refresh: new rows after the earlier watermark. */
  async refresh(): Promise<void> {
    await ch(
      `INSERT INTO ${this.db}.dex_events VALUES ${Array.from({ length: 25 }, (_, i) => `('2026-11-1${i % 2} 09:00:00','new${i}',${100 + i},0)`).join(",")}`,
    );
    await ch(
      `INSERT INTO ${this.db}.bridge_events VALUES ${Array.from({ length: 5 }, (_, i) => `('2026-11-10 12:00:00',${50 + i})`).join(",")}`,
    );
  }

  async drop(): Promise<void> {
    await ch(`DROP DATABASE IF EXISTS ${this.db}`).catch(() => undefined);
  }

  sources(panel: PanelSpec): string[] {
    return [this.def(panel).source];
  }

  private def(panel: PanelSpec): QueryDef {
    const d = this.queries[panel.queryRef.hash];
    if (!d) throw new Error(`unknown fixture query ${panel.queryRef.hash}`);
    return d;
  }

  async execute(panel: PanelSpec, pin: PanelPin): Promise<unknown> {
    const sql = await this.def(panel).sql(this.db, pin);
    const text = await ch(sql);
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown);
  }
}
