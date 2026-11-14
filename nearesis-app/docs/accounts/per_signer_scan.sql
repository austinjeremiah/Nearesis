WITH s AS (
  SELECT t.block_date AS block_date, t.signer_account_id AS signer, t.receiver_account_id AS receiver, COUNT(*) AS n
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
  WHERE t.block_date >= DATE '2025-11-10' AND t.block_date < DATE '2026-11-12'
  GROUP BY block_date, signer, receiver
), sc AS (
  SELECT block_date, signer, receiver, n,
    CASE WHEN receiver IN ('intents.near', 'verifier2.near') THEN 'intents'
      WHEN GREATEST(CAST(receiver IN ('bridge.near', 'omft.near', 'v2_1.omni.hot.tg') AS INT64), CAST(ENDS_WITH(receiver, '.omft.near') AS INT64)) = 1 THEN 'bridge'
      ELSE 'organic' END AS cls
  FROM s
), mp AS (
  SELECT * FROM UNNEST([
    STRUCT('v1:aurora:exact:aurora:2025-11-10' AS mapping_id, 'aurora' AS entity_id, 'exact' AS match_type, 'aurora' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:aurora:suffix:.aurora:2025-11-10' AS mapping_id, 'aurora' AS entity_id, 'suffix' AS match_type, '.aurora' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:bridge-near-namespace:suffix:.bridge.near:2025-11-10' AS mapping_id, 'bridge-near-namespace' AS entity_id, 'suffix' AS match_type, '.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'unverified' AS verification, 100 AS precedence),
    STRUCT('v1:dao.ref-finance:exact:ref-finance.sputnik-dao.near:2025-11-10' AS mapping_id, 'dao.ref-finance' AS entity_id, 'exact' AS match_type, 'ref-finance.sputnik-dao.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:hot-bridge:exact:omni.hot.tg:2025-11-10' AS mapping_id, 'hot-bridge' AS entity_id, 'exact' AS match_type, 'omni.hot.tg' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:hot-bridge:exact:v2_1.omni.hot.tg:2025-11-10' AS mapping_id, 'hot-bridge' AS entity_id, 'exact' AS match_type, 'v2_1.omni.hot.tg' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:hot:exact:game.hot.tg:2025-11-10' AS mapping_id, 'hot' AS entity_id, 'exact' AS match_type, 'game.hot.tg' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:hot:suffix:.hot.tg:2025-11-10' AS mapping_id, 'hot' AS entity_id, 'suffix' AS match_type, '.hot.tg' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:meme-cooking:exact:meme-cooking.near:2025-11-10' AS mapping_id, 'meme-cooking' AS entity_id, 'exact' AS match_type, 'meme-cooking.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 10 AS precedence),
    STRUCT('v1:meme-cooking:suffix:.meme-cooking.near:2025-11-10' AS mapping_id, 'meme-cooking' AS entity_id, 'suffix' AS match_type, '.meme-cooking.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:near-chain-signatures:exact:v1.signer:2025-11-10' AS mapping_id, 'near-chain-signatures' AS entity_id, 'exact' AS match_type, 'v1.signer' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:near-intents-poa:exact:omft.near:2025-11-10' AS mapping_id, 'near-intents-poa' AS entity_id, 'exact' AS match_type, 'omft.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 10 AS precedence),
    STRUCT('v1:near-intents-poa:suffix:.omft.near:2025-11-10' AS mapping_id, 'near-intents-poa' AS entity_id, 'suffix' AS match_type, '.omft.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:near-intents:exact:intents.near:2025-11-10' AS mapping_id, 'near-intents' AS entity_id, 'exact' AS match_type, 'intents.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:omni-bridge:exact:eth-prover-0_4_1.bridge.near:2025-11-10' AS mapping_id, 'omni-bridge' AS entity_id, 'exact' AS match_type, 'eth-prover-0_4_1.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:omni-bridge:exact:factory.bridge.near:2025-11-10' AS mapping_id, 'omni-bridge' AS entity_id, 'exact' AS match_type, 'factory.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:omni-bridge:exact:omdep.near:2025-11-10' AS mapping_id, 'omni-bridge' AS entity_id, 'exact' AS match_type, 'omdep.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:omni-bridge:exact:omni.bridge.near:2025-11-10' AS mapping_id, 'omni-bridge' AS entity_id, 'exact' AS match_type, 'omni.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:omni-bridge:exact:vaa-prover-0_4_1.bridge.near:2025-11-10' AS mapping_id, 'omni-bridge' AS entity_id, 'exact' AS match_type, 'vaa-prover-0_4_1.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:omni-bridge:exact:vaa-prover-0_4_3.bridge.near:2025-11-10' AS mapping_id, 'omni-bridge' AS entity_id, 'exact' AS match_type, 'vaa-prover-0_4_3.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 5 AS precedence),
    STRUCT('v1:rainbow-bridge:exact:client-eth2.bridge.near:2025-11-10' AS mapping_id, 'rainbow-bridge' AS entity_id, 'exact' AS match_type, 'client-eth2.bridge.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'unverified' AS verification, 5 AS precedence),
    STRUCT('v1:rhea:exact:boostfarm.ref-labs.near:2025-11-10' AS mapping_id, 'rhea' AS entity_id, 'exact' AS match_type, 'boostfarm.ref-labs.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:rhea:exact:dclv2.ref-labs.near:2025-11-10' AS mapping_id, 'rhea' AS entity_id, 'exact' AS match_type, 'dclv2.ref-labs.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:rhea:exact:token.rhealab.near:2025-11-10' AS mapping_id, 'rhea' AS entity_id, 'exact' AS match_type, 'token.rhealab.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:rhea:exact:v2.ref-finance.near:2025-11-10' AS mapping_id, 'rhea' AS entity_id, 'exact' AS match_type, 'v2.ref-finance.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:rhea:suffix:.rhealab.near:2025-11-10' AS mapping_id, 'rhea' AS entity_id, 'suffix' AS match_type, '.rhealab.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:sputnik-dao:exact:sputnik-dao.near:2025-11-10' AS mapping_id, 'sputnik-dao' AS entity_id, 'exact' AS match_type, 'sputnik-dao.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:sputnik-dao:suffix:.sputnik-dao.near:2025-11-10' AS mapping_id, 'sputnik-dao' AS entity_id, 'suffix' AS match_type, '.sputnik-dao.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:sweat:exact:token.sweat:2025-11-10' AS mapping_id, 'sweat' AS entity_id, 'exact' AS match_type, 'token.sweat' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:sweat:suffix:.sweat:2025-11-10' AS mapping_id, 'sweat' AS entity_id, 'suffix' AS match_type, '.sweat' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'inferred' AS verification, 100 AS precedence),
    STRUCT('v1:token.usdt:exact:usdt.tether-token.near:2025-11-10' AS mapping_id, 'token.usdt' AS entity_id, 'exact' AS match_type, 'usdt.tether-token.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:token.wnear:exact:wrap.near:2025-11-10' AS mapping_id, 'token.wnear' AS entity_id, 'exact' AS match_type, 'wrap.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'verified' AS verification, 10 AS precedence),
    STRUCT('v1:wormhole:exact:contract.wormhole_crypto.near:2025-11-10' AS mapping_id, 'wormhole' AS entity_id, 'exact' AS match_type, 'contract.wormhole_crypto.near' AS account, TIMESTAMP '2025-11-10 00:00:00+00' AS eff_from, CAST(NULL AS TIMESTAMP) AS eff_to, 'unverified' AS verification, 5 AS precedence)
  ])
), rcv AS (
  SELECT DISTINCT receiver FROM s
), cand AS (
  SELECT r.receiver AS receiver, m.entity_id AS entity_id, m.verification AS verification, m.precedence AS precedence,
    m.eff_from AS eff_from, m.eff_to AS eff_to, 1000000 AS spec
  FROM rcv r JOIN mp m ON m.match_type = 'exact' AND m.account = r.receiver
  UNION ALL
  SELECT r.receiver, m.entity_id, m.verification, m.precedence, m.eff_from, m.eff_to, LENGTH(m.account)
  FROM rcv r JOIN mp m ON m.match_type = 'suffix' AND ENDS_WITH(r.receiver, m.account) AND LENGTH(r.receiver) > LENGTH(m.account)
), rd AS (
  SELECT DISTINCT block_date, receiver FROM s
), eff AS (
  SELECT rd.block_date AS block_date, c.receiver AS receiver, c.entity_id AS entity_id, c.verification AS verification,
    RANK() OVER (PARTITION BY rd.block_date, c.receiver ORDER BY c.spec DESC, c.precedence ASC) AS rk
  FROM rd JOIN cand c ON c.receiver = rd.receiver
  WHERE TIMESTAMP(rd.block_date) >= c.eff_from AND COALESCE(c.eff_to, TIMESTAMP '9999-12-31 00:00:00+00') > TIMESTAMP(rd.block_date)
), win AS (
  SELECT block_date, receiver, COUNT(DISTINCT entity_id) AS n_ent, MIN(entity_id) AS entity_id,
    IF(COUNTIF(verification = 'unverified') > 0, 'unverified', IF(COUNTIF(verification = 'inferred') > 0, 'inferred', 'verified')) AS verification
  FROM eff WHERE rk = 1 GROUP BY block_date, receiver
), rb AS (
  SELECT block_date, receiver,
    CASE WHEN n_ent > 1 THEN '__ambiguous__' WHEN verification = 'unverified' THEN '__unverified__' ELSE entity_id END AS bucket
  FROM win
), sb AS (
  SELECT sc.block_date AS block_date, sc.signer AS signer, sc.cls AS cls, sc.n AS n, COALESCE(rb.bucket, '__unclassified__') AS bucket
  FROM sc LEFT JOIN rb ON rb.block_date = sc.block_date AND rb.receiver = sc.receiver
), d AS (
  SELECT block_date, signer, SUM(n) AS n_all, SUM(IF(cls = 'organic', n, 0)) AS n_org,
    SUM(IF(cls = 'intents', n, 0)) AS n_int, SUM(IF(cls = 'bridge', n, 0)) AS n_br
  FROM sc GROUP BY block_date, signer
), o AS (
  SELECT block_date, signer, n_org FROM d WHERE n_org > 0
), fs AS (
  SELECT signer, MIN(block_date) AS first_day FROM o GROUP BY signer
), ranked AS (
  SELECT o.block_date AS block_date, o.signer AS signer, o.n_org AS n_org, (o.block_date = fs.first_day) AS is_new,
    ROW_NUMBER() OVER (PARTITION BY o.block_date ORDER BY o.n_org DESC, o.signer) AS rk,
    COUNT(*) OVER (PARTITION BY o.block_date) AS cnt
  FROM o JOIN fs ON fs.signer = o.signer
), da AS (
  SELECT block_date, COUNT(*) AS signers_all, SUM(n_all) AS tx_all, SUM(n_int) AS tx_int, SUM(n_br) AS tx_br,
    COUNTIF(n_int > 0) AS signers_with_intents
  FROM d GROUP BY block_date
), db AS (
  SELECT block_date, ANY_VALUE(cnt) AS signers_org, SUM(n_org) AS tx_org,
    SUM(IF(rk <= 10, n_org, 0)) AS top10_tx,
    COUNTIF(n_org < 100) AS tail_signers, SUM(IF(n_org < 100, n_org, 0)) AS tail_tx,
    COUNTIF(is_new) AS new_signers, SUM(IF(is_new, n_org, 0)) AS new_tx,
    COUNTIF(rk <= CEIL(cnt * 0.01)) AS top1_count, SUM(IF(rk <= CEIL(cnt * 0.01), n_org, 0)) AS top1_tx,
    COUNTIF(rk <= CEIL(cnt * 0.05)) AS top5_count, SUM(IF(rk <= CEIL(cnt * 0.05), n_org, 0)) AS top5_tx
  FROM ranked GROUP BY block_date
), ent AS (
  SELECT block_date, bucket, COUNT(DISTINCT signer) AS signers_all, SUM(n) AS tx_all,
    COUNT(DISTINCT IF(cls = 'organic', signer, NULL)) AS signers_org, SUM(IF(cls = 'organic', n, 0)) AS tx_org
  FROM sb GROUP BY block_date, bucket
), ret AS (
  SELECT DATE_TRUNC(fs.first_day, WEEK(MONDAY)) AS cohort_week, DATE_TRUNC(o.block_date, WEEK(MONDAY)) AS active_week,
    COUNT(DISTINCT o.signer) AS signers
  FROM o JOIN fs ON fs.signer = o.signer GROUP BY cohort_week, active_week
), hp AS (
  SELECT signer, MIN(block_date) AS first_day, MAX(block_date) AS last_day, COUNT(*) AS head_days FROM o WHERE n_org >= 100 GROUP BY signer
), prof AS (
  SELECT hp.signer AS signer, fs.first_day AS first_day, MAX(o.block_date) AS last_day, COUNT(*) AS active_days,
    SUM(o.n_org) AS tx_org, ANY_VALUE(hp.head_days) AS head_days
  FROM hp JOIN fs ON fs.signer = hp.signer JOIN o ON o.signer = hp.signer GROUP BY hp.signer, fs.first_day
)
SELECT 'head' AS kind, block_date, signer AS key, n_org AS v1, CAST(NULL AS INT64) AS v2, CAST(NULL AS INT64) AS v3, CAST(NULL AS INT64) AS v4,
  CAST(NULL AS INT64) AS v5, CAST(NULL AS INT64) AS v6, CAST(NULL AS INT64) AS v7, CAST(NULL AS INT64) AS v8
FROM o WHERE n_org >= 100
UNION ALL
SELECT 'day_a', da.block_date, CAST(NULL AS STRING), da.signers_all, da.tx_all, da.tx_int, da.tx_br, da.signers_with_intents,
  COALESCE(db.signers_org, 0), COALESCE(db.tx_org, 0), COALESCE(db.top10_tx, 0)
FROM da LEFT JOIN db ON db.block_date = da.block_date
UNION ALL
SELECT 'day_b', block_date, CAST(NULL AS STRING), tail_signers, tail_tx, new_signers, new_tx, top1_count, top1_tx, top5_count, top5_tx
FROM db
UNION ALL
SELECT 'entity', block_date, bucket, signers_all, tx_all, signers_org, tx_org, NULL, NULL, NULL, NULL FROM ent
UNION ALL
SELECT 'retention', active_week, CAST(cohort_week AS STRING), signers, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM ret
UNION ALL
SELECT 'profile', first_day, signer, UNIX_DATE(last_day), active_days, tx_org, head_days, NULL, NULL, NULL, NULL FROM prof
