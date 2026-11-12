import {
  CUBES,
  LIVE_CUBES,
  cubeSqlPreAggregations,
  queryRows,
  type ClickHouseClient,
  type CubeDef,
} from "@nearesis/analytics";

/** Why a pre-aggregation that covers a query could not be used for the estimate. */
export type RollupState = "fresh" | "unbuilt" | "stale";

export interface RollupRate {
  preAggregationId: string;
  /** fact table the rollup aggregates (the cost-gate source dataset it replaces) */
  table: string;
  state: RollupState;
  /** rollup rows per covered day; only meaningful when state is "fresh" */
  rowsPerDay: number;
}

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Looks up the pre-aggregations that Cube itself would serve `cubeQuery` from, and for each one whether a built table
 * exists that is NEWER than the last change of its source table (system.parts), and how many rows per day it holds.
 *
 * "Newer" is judged on the earliest of the rollup's metadata time and its first part, so a rollup is never called fresh
 * because a rename or a late part write made it look recent: when in doubt it is stale, and a stale or unbuilt rollup
 * is estimated from the raw table (never an under-estimate).
 */
export async function rollupRates(
  ch: ClickHouseClient,
  cubeUrl: string,
  token: string,
  cubeQuery: Record<string, unknown>,
  cubes: CubeDef[] = [...CUBES, ...LIVE_CUBES],
): Promise<RollupRate[]> {
  return (await inspectRollups(ch, cubeUrl, token, cubeQuery, cubes)).map((x) => x.rate);
}

/** A covering rollup together with the vintage evidence behind its state (epoch seconds; null when not measurable). */
export interface RollupInspection {
  rate: RollupRate;
  builtAtSec: number | null;
  sourceChangedAtSec: number | null;
}

export async function inspectRollups(
  ch: ClickHouseClient,
  cubeUrl: string,
  token: string,
  cubeQuery: Record<string, unknown>,
  cubes: CubeDef[] = [...CUBES, ...LIVE_CUBES],
): Promise<RollupInspection[]> {
  const uses = await cubeSqlPreAggregations(cubeUrl, token, { ...cubeQuery, timezone: "UTC" });
  const out: RollupInspection[] = [];
  const push = (
    rate: RollupRate,
    builtAtSec: number | null = null,
    sourceChangedAtSec: number | null = null,
  ) => out.push({ rate, builtAtSec, sourceChangedAtSec });
  for (const u of uses) {
    const [cubeName] = u.preAggregationId.split(".");
    const cube = cubes.find((c) => c.name === cubeName);
    if (!cube) continue;
    const [schema, base] = u.tableName.split(".");
    if (!schema || !base) continue;
    const built = await queryRows<{ name: string; built: string }>(
      ch,
      `SELECT t.name AS name,
              least(toUInt32(toUnixTimestamp(t.metadata_modification_time)), ifNull(p.first_part, 4294967295)) AS built_at,
              toString(built_at) AS built
       FROM system.tables AS t
       LEFT JOIN (SELECT \`table\` AS tbl, toUInt32(toUnixTimestamp(min(modification_time))) AS first_part FROM system.parts
                  WHERE database = {schema:String} AND active GROUP BY tbl) AS p ON p.tbl = t.name
       WHERE t.database = {schema:String}
         AND match(t.name, {re:String})
         AND t.total_rows > 0
       ORDER BY built_at DESC, name DESC LIMIT 1`,
      { schema, re: `^${base.replace(RE_ESCAPE, "\\$&")}_[a-z0-9]+_[a-z0-9]+_[a-z0-9]+$` },
    );
    const b = built[0];
    if (!b) {
      push({ preAggregationId: u.preAggregationId, table: cube.table, state: "unbuilt", rowsPerDay: 0 });
      continue;
    }
    const src = await queryRows<{ m: string }>(
      ch,
      `SELECT toString(ifNull(max(toUnixTimestamp(modification_time)), 0)) AS m FROM system.parts
       WHERE database = currentDatabase() AND table = {t:String} AND active`,
      { t: cube.table },
    );
    if (Number(b.built) <= Number(src[0]?.m ?? 0)) {
      push(
        { preAggregationId: u.preAggregationId, table: cube.table, state: "stale", rowsPerDay: 0 },
        Number(b.built),
        Number(src[0]?.m ?? 0),
      );
      continue;
    }
    const size = await queryRows<{ n: string; d: string }>(
      ch,
      // identifiers cannot be bound; `schema`/`name` come from system.tables, `cubeName` from the model definition
      `SELECT toString(count()) AS n, toString(uniqExact(\`${cube.name}__day_day\`)) AS d FROM \`${schema}\`.\`${b.name}\``,
    );
    const rows = Number(size[0]?.n ?? 0);
    const days = Number(size[0]?.d ?? 0);
    if (rows === 0 || days === 0) {
      push({ preAggregationId: u.preAggregationId, table: cube.table, state: "unbuilt", rowsPerDay: 0 });
      continue;
    }
    push(
      {
        preAggregationId: u.preAggregationId,
        table: cube.table,
        state: "fresh",
        rowsPerDay: Math.max(1, rows / days),
      },
      Number(b.built),
      Number(src[0]?.m ?? 0),
    );
  }
  return out;
}

/**
 * Replaces the raw rows/day of a source with the rollup's rows/day when a FRESH rollup covers the query. Any covering
 * rollup of the same table that is not fresh keeps the raw rate. The rollup rate is not clamped to the raw rate: a rollup
 * larger than its table is estimated honestly.
 */
export function applyRollupRates(
  perDay: Record<string, number>,
  rollups: RollupRate[],
): { perDay: Record<string, number>; served: string[]; notReady: RollupRate[] } {
  const out = { ...perDay };
  const served: string[] = [];
  const notReady = rollups.filter((r) => r.state !== "fresh");
  const blocked = new Set(notReady.map((r) => r.table));
  for (const r of rollups) {
    if (r.state !== "fresh" || blocked.has(r.table)) continue;
    for (const s of Object.keys(out)) {
      if (s.slice(s.indexOf(":") + 1) !== r.table) continue;
      out[s] = r.rowsPerDay;
      served.push(r.preAggregationId);
    }
  }
  return { perDay: out, served, notReady };
}
