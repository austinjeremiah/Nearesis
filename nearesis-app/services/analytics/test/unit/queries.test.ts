import { afterAll, beforeAll, expect, test } from "vitest";
import { createPg, loadQuery, migratePg, saveQuery, sha256 } from "../../src/index.ts";

const pool = createPg();
const hash = sha256(`queries-test-${Math.random()}`);
beforeAll(async () => {
  await migratePg(pool);
});
afterAll(async () => pool.end());

test("query registry is content-addressed and insert-only", async () => {
  const q = {
    queryHash: hash,
    ast: { measures: ["a.b"], limit: 5 },
    semanticVersion: "1.0.0",
    semanticModelHash: "ab".repeat(32),
  };
  await saveQuery(pool, q);
  await saveQuery(pool, { ...q, ast: { different: true } }); // same hash: ignored
  expect(await loadQuery(pool, hash)).toEqual(q);
  expect(await loadQuery(pool, "0".repeat(64))).toBeNull();
  await expect(
    pool.query("UPDATE analytics_meta.query_registry SET semantic_version = 'x' WHERE query_hash = $1", [
      hash,
    ]),
  ).rejects.toThrow(/insert-only/);
  await expect(
    pool.query("DELETE FROM analytics_meta.query_registry WHERE query_hash = $1", [hash]),
  ).rejects.toThrow(/insert-only/);
});
