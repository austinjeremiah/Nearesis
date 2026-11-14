-- thesis dataset: swaps_coverage  (Days marked partial or incomplete in the swaps source coverage)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 27
-- result file: raw/swaps_coverage.json
-- result sha256: 7db31bc754d1ca33deaf20a59459015b8e3d6db98e29e2362200d3eb380b16de
-- reproduce: pnpm thesis:data
SELECT day AS d, state, ifNull(reason, '') AS reason
FROM nearesis_live.source_coverage FINAL
WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete' AND day BETWEEN '2025-11-09' AND {e:Date}
ORDER BY d
