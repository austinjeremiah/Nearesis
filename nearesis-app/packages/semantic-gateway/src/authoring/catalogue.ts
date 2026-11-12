import { createHash } from "node:crypto";
import { canonicalJson, queryRows, type ClickHouseClient } from "@nearesis/analytics";

/**
 * Source catalogue: the only tables and columns a metric proposal may reference. It is GENERATED from the ClickHouse
 * schema of the target database (`nearesis_live` in production) and then narrowed by three static, reviewed lists:
 * which tables are authorable, which columns are denied (privacy / provenance internals), and which declared
 * units each measure carries. A column that is not in the generated catalogue cannot be referenced (S03, S14).
 */
export type ColumnKind = "time" | "dimension" | "measure";

export interface CatalogueColumn {
  name: string;
  chType: string;
  kind: ColumnKind;
  nullable: boolean;
  /** Declared unit of a measure. null = not declared: sum/avg/min/max over it is refused (UNIT_UNKNOWN). */
  unit: string | null;
  decimalScale: number | null;
}

export interface CatalogueTable {
  id: string;
  database: string;
  engine: string;
  /** `final`: ReplacingMergeTree, so reads need FINAL (dedup). `none`: a view or plain table that is unique by construction. */
  dedup: "final" | "none";
  /** source_coverage provider/dataset (null: the table has no coverage rows, so cost and coverage are unknown). */
  provider: string | null;
  coverageDataset: string | null;
  /** null = shared source data. A tenant id marks a tenant-private table that only that tenant may reference. */
  tenantId: string | null;
  columns: Record<string, CatalogueColumn>;
  denied: string[];
}

export interface DeclaredJoin {
  left: { table: string; column: string };
  right: { table: string; column: string };
  /** Both sides are day-keyed. Aggregates are computed per table and merged per time bucket; rows are never multiplied. */
  kind: "time_bucket";
}

export interface SourceCatalogue {
  database: string;
  hash: string;
  tables: Record<string, CatalogueTable>;
  joins: DeclaredJoin[];
}

/** Tables a metric may be authored over, with their coverage identity. Infrastructure tables (coverage, gaps, migrations) are excluded. */
export const AUTHORABLE_TABLES: Record<string, { provider: string | null; coverageDataset: string | null }> =
  {
    near_daily_tx: { provider: "near-bigquery", coverageDataset: "near_daily_tx" },
    account_daily_activity: { provider: "near-bigquery", coverageDataset: "account_daily_activity" },
    contract_interactions: { provider: "near-bigquery", coverageDataset: "contract_interactions" },
    intents_swaps: { provider: "near-explorer", coverageDataset: "intents_swaps" },
    price_candles: { provider: "coingecko", coverageDataset: "price_candles" },
    quote_attempts: { provider: null, coverageDataset: null },
    // A18 economics (units and tables requested through the integration queue). The tables exist after migrateEconomics().
    near_economics_tx_daily: { provider: "near-bigquery", coverageDataset: "near_economics_tx_daily" },
    near_economics_gas_price_daily: {
      provider: "near-bigquery",
      coverageDataset: "near_economics_gas_price_daily",
    },
  };

/** Columns never exposed to authoring: identifiers of individuals' deposits, free-form memos, provenance internals, raw strings. */
export const DENIED_COLUMNS =
  /^(raw_object_hash|deposit_address|deposit_memo|referral|source_raw_object_hash|version|fetched_at|source_label|.*_raw|public_swap_tx_hashes|boundary_tx_hashes)$/;

/** Declared units (the schema does not carry them). A numeric column absent here has no unit and cannot be summed. */
export const COLUMN_UNITS: Record<string, string> = {
  "near_daily_tx.tx_count": "tx",
  "near_daily_tx.distinct_signer_proxy": "account",
  "account_daily_activity.tx_total": "tx",
  "account_daily_activity.tx_intents": "tx",
  "account_daily_activity.tx_bridge": "tx",
  "account_daily_activity.tx_organic": "tx",
  "account_daily_activity.signers_total": "account",
  "account_daily_activity.signers_organic": "account",
  "account_daily_activity.signers_with_intents": "account",
  "contract_interactions.interactions": "interaction",
  "intents_swaps.amount_in_usd": "USD",
  "intents_swaps.amount_out_usd": "USD",
  "quote_attempts.amount_in_usd": "USD",
  "quote_attempts.amount_out_usd": "USD",
  "quote_attempts.notional_usd": "USD",
  "quote_attempts.latency_ms": "ms",
  "quote_attempts.time_estimate_s": "s",
  "near_economics_tx_daily.txs": "tx",
  "near_economics_tx_daily.receipts": "receipt",
  "near_economics_tx_daily.total_gas": "gas",
  "near_economics_tx_daily.total_tokens_yocto": "yoctoNEAR",
  "near_economics_tx_daily.conversion_gas": "gas",
  "near_economics_tx_daily.conversion_tokens_yocto": "yoctoNEAR",
  "near_economics_tx_daily.receipt_gas": "gas",
  "near_economics_tx_daily.receipt_tokens_yocto": "yoctoNEAR",
  "near_economics_gas_price_daily.blocks": "1",
  "near_economics_gas_price_daily.sum_gas_price_yocto": "yoctoNEAR/gas",
};

/** Declared joins: day-keyed only. Anything else is refused (JOIN_NOT_DECLARED). */
export const DECLARED_JOINS: DeclaredJoin[] = [
  ["account_daily_activity", "block_date", "near_daily_tx", "block_date"],
  ["contract_interactions", "block_date", "near_daily_tx", "block_date"],
  ["contract_interactions", "block_date", "account_daily_activity", "block_date"],
  ["intents_swaps", "created_day", "near_daily_tx", "block_date"],
  ["price_candles", "day", "near_daily_tx", "block_date"],
  ["intents_swaps", "created_day", "price_candles", "day"],
].map(([lt, lc, rt, rc]) => ({
  left: { table: lt as string, column: lc as string },
  right: { table: rt as string, column: rc as string },
  kind: "time_bucket" as const,
}));

const BASE = (t: string) =>
  t
    .replace(/^(?:Nullable|LowCardinality)\((.*)\)$/, "$1")
    .replace(/^(?:Nullable|LowCardinality)\((.*)\)$/, "$1");

export function classifyType(
  chType: string,
): { kind: ColumnKind; nullable: boolean; scale: number | null } | null {
  const nullable = /Nullable\(/.test(chType);
  const t = BASE(chType);
  if (/^(Array|Map|Tuple|Nested|JSON|Object|Variant|Dynamic)/.test(t)) return null;
  if (/^Date(Time)?(64)?(\(|$)/.test(t)) return { kind: "time", nullable, scale: null };
  const dec = /^Decimal(?:\d+)?\((\d+),\s*(\d+)\)$/.exec(t);
  if (dec) return { kind: "measure", nullable, scale: Number(dec[2]) };
  if (/^(U?Int\d+|Float\d+)$/.test(t)) return { kind: "measure", nullable, scale: null };
  if (/^(String|FixedString\(\d+\)|Bool)$/.test(t)) return { kind: "dimension", nullable, scale: null };
  return null;
}

export interface BuildCatalogueOptions {
  database: string;
  /** Tenant-private tables (table id -> owning tenant). Everything else is shared source data. */
  tenantTables?: Record<string, string>;
}

/** Generates the catalogue from system.columns / system.tables. Parameterized; nothing is interpolated. */
export async function buildSourceCatalogue(
  ch: ClickHouseClient,
  opts: BuildCatalogueOptions,
): Promise<SourceCatalogue> {
  const cols = await queryRows<{ table: string; name: string; type: string; position: string }>(
    ch,
    `SELECT \`table\` AS \`table\`, name, type, toString(position) AS position FROM system.columns
     WHERE database = {db:String} AND \`table\` IN {tables:Array(String)} ORDER BY \`table\`, position`,
    { db: opts.database, tables: Object.keys(AUTHORABLE_TABLES) },
  );
  const tabs = await queryRows<{ name: string; engine: string }>(
    ch,
    `SELECT name, engine FROM system.tables WHERE database = {db:String} AND name IN {tables:Array(String)}`,
    { db: opts.database, tables: Object.keys(AUTHORABLE_TABLES) },
  );
  const tables: Record<string, CatalogueTable> = {};
  for (const t of tabs) {
    const meta = AUTHORABLE_TABLES[t.name];
    if (!meta) continue;
    tables[t.name] = {
      id: t.name,
      database: opts.database,
      engine: t.engine,
      dedup: /^Replacing/.test(t.engine) ? "final" : "none",
      provider: meta.provider,
      coverageDataset: meta.coverageDataset,
      tenantId: opts.tenantTables?.[t.name] ?? null,
      columns: {},
      denied: [],
    };
  }
  for (const c of cols) {
    const tab = tables[c.table];
    if (!tab) continue;
    if (DENIED_COLUMNS.test(c.name)) {
      tab.denied.push(c.name);
      continue;
    }
    const k = classifyType(c.type);
    if (!k) {
      tab.denied.push(c.name);
      continue;
    }
    tab.columns[c.name] = {
      name: c.name,
      chType: c.type,
      kind: k.kind,
      nullable: k.nullable,
      unit: k.kind === "measure" ? (COLUMN_UNITS[`${c.table}.${c.name}`] ?? null) : null,
      decimalScale: k.scale,
    };
  }
  const joins = DECLARED_JOINS.filter(
    (j) =>
      tables[j.left.table]?.columns[j.left.column]?.kind === "time" &&
      tables[j.right.table]?.columns[j.right.column]?.kind === "time",
  );
  const body = { database: opts.database, tables, joins };
  return { ...body, hash: createHash("sha256").update(canonicalJson(body)).digest("hex") };
}
