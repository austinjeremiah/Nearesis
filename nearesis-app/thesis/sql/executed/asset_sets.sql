-- thesis dataset: asset_sets  (The asset sets used for F5, F6 and F7 (registry rows))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 50
-- result file: raw/asset_sets.json
-- result sha256: 2fa260e3b9419b6569182bfc33785cc054e3ebe28b5f3851cb69c216213f2c34
-- reproduce: pnpm thesis:data
SELECT 'stable' AS set_name, provider_asset_id, symbol_observed AS symbol, blockchain, verification
FROM nearesis_live.asset_registry FINAL WHERE upper(symbol_observed) IN ('DAI', 'FRAX', 'USD1', 'USDC', 'USDCX', 'USDG', 'USDT', 'USDT0', 'USDE', 'USDF')
UNION ALL
SELECT 'near_token', provider_asset_id, symbol_observed, blockchain, verification
FROM nearesis_live.asset_registry FINAL WHERE upper(symbol_observed) IN ('NEAR', 'WNEAR')
ORDER BY 1, 3, 4, 2
