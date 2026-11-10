import type pg from "pg";

export interface SavedQuery {
  queryHash: string;
  ast: unknown;
  semanticVersion: string;
  semanticModelHash: string;
}

/** Insert-only, content-addressed: the same hash is stored once (ON CONFLICT DO NOTHING). */
export async function saveQuery(pool: pg.Pool, q: SavedQuery): Promise<void> {
  await pool.query(
    `INSERT INTO analytics_meta.query_registry (query_hash, ast, semantic_version, semantic_model_hash)
     VALUES ($1, $2::jsonb, $3, $4) ON CONFLICT (query_hash) DO NOTHING`,
    [q.queryHash, JSON.stringify(q.ast), q.semanticVersion, q.semanticModelHash],
  );
}

export async function loadQuery(pool: pg.Pool, queryHash: string): Promise<SavedQuery | null> {
  const r = await pool.query(
    "SELECT query_hash, ast, semantic_version, semantic_model_hash FROM analytics_meta.query_registry WHERE query_hash = $1",
    [queryHash],
  );
  const row = r.rows[0];
  return row
    ? {
        queryHash: row.query_hash,
        ast: row.ast,
        semanticVersion: row.semantic_version,
        semanticModelHash: row.semantic_model_hash,
      }
    : null;
}
