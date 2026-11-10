import { afterAll, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { observe } from "@nearesis/acceptance";
import {
  DECIMAL_EDGE_AMOUNTS,
  cubeLoad,
  decimalEdge,
  defaultCubeSecret,
  queryRows,
  signCubeToken,
} from "@nearesis/analytics";
import { ast, CUBE_URL, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(decimalEdge());
});
afterAll(async () => env.close());

test("S15 yocto-scale amounts are exact through ClickHouse, Cube and the gateway", async () => {
  const usd = DECIMAL_EDGE_AMOUNTS.map((_, i) => `${i}.000000000000000001`);
  const script = fileURLToPath(new URL("./S15_reference.py", import.meta.url));
  const ref = spawnSync("python3", ["-I", script, JSON.stringify({ amounts: DECIMAL_EDGE_AMOUNTS, usd })], {
    encoding: "utf8",
  });
  expect(ref.status, ref.stderr).toBe(0);
  const expected = JSON.parse(ref.stdout) as {
    sum_amount_in: string;
    sum_usd: string;
    float64_sum_amount_in: string;
  };
  // The independent exact result differs from the float64 result (this fixture must trip a float path).
  expect(BigInt(expected.sum_amount_in).toString()).not.toBe(
    BigInt(Math.trunc(Number(expected.float64_sum_amount_in))).toString(),
  );
  expect(expected.sum_amount_in).toBe(DECIMAL_EDGE_AMOUNTS.reduce((a, b) => a + BigInt(b), 0n).toString());

  // (a) stored amounts equal the source strings, both the source-string column and the Decimal256 column.
  const stored = await queryRows<{ k: string; raw: string; dec: string }>(
    env.ch,
    `SELECT swap_key AS k, amount_in_raw AS raw, toString(amount_in) AS dec FROM intents_swaps FINAL ORDER BY swap_key`,
  );
  expect(stored.map((s) => s.raw)).toEqual(DECIMAL_EDGE_AMOUNTS);
  expect(stored.map((s) => s.dec)).toEqual(DECIMAL_EDGE_AMOUNTS);
  const ddl = (
    await queryRows<{ statement: string }>(
      env.ch,
      `SELECT create_table_query AS statement FROM system.tables WHERE database = currentDatabase() AND name = 'intents_swaps'`,
    )
  )[0]!.statement;
  expect(ddl).toContain("`amount_in` Decimal(76, 0)");
  expect(ddl).not.toMatch(/Float/);

  // (b) Cube direct and gateway aggregates equal the independent result digit for digit.
  const token = signCubeToken(defaultCubeSecret(), { tenantId: "t1", workspaceId: "w1" });
  const cube = await cubeLoad(CUBE_URL, token, {
    measures: ["intents.oneclick_amount_in_smallest_unit", "intents.oneclick_volume_usd"],
    timeDimensions: [
      {
        dimension: "intents.day",
        granularity: "day",
        dateRange: ["2026-10-01T00:00:00.000", "2026-10-01T23:59:59.999"],
      },
    ],
    cache: "must-revalidate",
  });
  expect(cube.data[0]!["intents.oneclick_amount_in_smallest_unit"]).toBe(expected.sum_amount_in);
  expect(cube.data[0]!["intents.oneclick_volume_usd"]).toBe(
    `${expected.sum_usd.split(".")[0]}.${(expected.sum_usd.split(".")[1] ?? "").padEnd(18, "0")}`,
  );

  const gw = env.gateway();
  const g = await gw.query(
    W1,
    ast({
      measures: ["intents.oneclick_amount_in_smallest_unit"],
      time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z", grain: "day" },
    }),
  );
  expect(g.ok).toBe(true);
  if (!g.ok) return;
  expect(g.envelope.rows[0]![1]).toBe(expected.sum_amount_in);
  expect(g.envelope.columns[1]).toMatchObject({ type: "decimal", scale: 0, unit: "smallest_unit" });
  const gu = await gw.query(
    W1,
    ast({
      measures: ["intents.oneclick_volume_usd"],
      time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z", grain: "day" },
    }),
  );
  expect(gu.ok).toBe(true);
  if (!gu.ok) return;
  expect(gu.envelope.rows[0]![1]).toBe("10.000000000000000005");
  expect(gu.envelope.columns[1]).toMatchObject({ type: "decimal", scale: 18, unit: "usd" });

  // (c) no JSON number beyond 2^53 anywhere in the serialized envelopes (exact amounts are quoted strings).
  for (const body of [JSON.stringify(g.envelope), JSON.stringify(gu.envelope)]) {
    const unquoted = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const n of unquoted.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [])
      expect(Math.abs(Number(n))).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  }
  observe({
    testId: "S15",
    observed: `5 amounts incl. 2^128-1 stored exactly (source string + Decimal256(0)); Cube and gateway sum = ${expected.sum_amount_in} equals Python decimal(prec 80) result digit for digit (float64 would give ${expected.float64_sum_amount_in}); USD sum 10.000000000000000005 scale 18; envelope columns typed decimal with scale; no unquoted JSON number > 2^53`,
    fixtureHash: decimalEdge().digest,
    evidence: {
      comparison: stored.map((s, i) => ({
        source: DECIMAL_EDGE_AMOUNTS[i],
        stored: s.raw,
        decimal256: s.dec,
        equal: s.raw === DECIMAL_EDGE_AMOUNTS[i] && s.dec === DECIMAL_EDGE_AMOUNTS[i],
      })),
      expected,
      cubeAmount: cube.data[0]!["intents.oneclick_amount_in_smallest_unit"],
      gatewayAmount: g.envelope.rows[0]![1],
      gatewayUsd: gu.envelope.rows[0]![1],
      columnDdl: ddl.split("\n").filter((l) => /amount|usd/.test(l)),
      referenceScriptSha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
      referenceOutputSha256: createHash("sha256").update(ref.stdout).digest("hex"),
    },
  });
});
