# Provider documentation checked before implementation (ch.18 "Systematic docs review before code")

Checked by Engine B lead, accessedAt **2026-11-10** (UTC). Facts below come from the provider's published spec or docs page on that date. Anything not listed is `TO_VERIFY`.

## NEAR Intents Explorer

- Spec: `https://explorer.near-intents.org/api/v0/openapi.yaml` (HTTP 200, `text/yaml`). SHA-256 of the downloaded bytes: `eec0c12615083b0b409ec746fac96183b81c7c74359dc7fffecacf62b77ffb5e`. Rendered docs: `https://explorer.near-intents.org/api/docs`.
- Paths: `GET /api/v0/transactions`, `GET /api/v0/partner-any-quotes`. Security: bearer JWT on all endpoints.
- Rate limit (spec text): "maximum of 1 request every 5 seconds" per partner ID from the JWT; excess returns 429.
- `/transactions` query params: `numberOfTransactions` (1–1000, default 50), `lastDepositAddress` + `lastDepositMemo` (cursor; `lastDepositAddressAndMemo` DEPRECATED), `direction` (`next` = older, `prev` = newer; default `next`), `search`, `fromChainId`, `fromTokenId`, `toChainId`, `toTokenId`, `depositMemo`, `referral`, `affiliate`, `statuses` (comma list: FAILED, INCOMPLETE_DEPOSIT, PENDING_DEPOSIT, PROCESSING, REFUNDED, SUCCESS; default FAILED,PROCESSING,REFUNDED,SUCCESS), `showTestTxs`, `minUsdPrice`, `maxUsdPrice`, `startTimestamp`/`endTimestamp` (ISO, both **non-inclusive**), `startTimestampUnix`/`endTimestampUnix`.
- Response 200: JSON **array** of transactions. Required fields: `originAsset, destinationAsset, depositAddress, depositMemo (nullable), depositAddressAndMemo, createdAt, createdAtTimestamp, intentHashes (nullable), amountInFormatted, amountOutFormatted, appFees[{recipient, fee:number}], nearTxHashes[], originChainTxHashes[], destinationChainTxHashes[], amountIn, amountInUsd, amountOut, amountOutUsd, refundTo, refundFeeFormatted (nullable), depositType, recipientType, refundType`. Optional: `recipient, status, referral, senders[], refundReason, refundFee`.
  - `amountIn`/`amountOut` are smallest-unit **strings**; they "read 0 while the swap is in flight" (so 0 is not an observed amount for non-final statuses).
  - `depositType`/`recipientType`/`refundType` ∈ `ORIGIN_CHAIN | INTENTS | CONFIDENTIAL_INTENTS` (private-settlement era signal).
  - Filters note "setting this excludes masking transactions" → the Explorer feed contains masking (shield/unshield) rows.
- Errors: 400/401 `{status, error:{code,message}}`; 429 `{status:429, error:{code,message}}`. The spec does not document a `Retry-After` header → honour it if present, else exponential backoff with the 5 s floor.
- **Stable identity** (no `id` field exists): `depositAddress` + `depositMemo` (null memo → empty string). Matches the pagination cursor fields.

## 1Click API

- Spec: `https://1click.chaindefuser.com/docs/v0/openapi.yaml` (HTTP 200). SHA-256 `9a2e676682aa6dec6905c82f1b2cc0ec72eda97964369aa51ec35eb82ccac0a3`.
- `GET /v0/tokens` → array of `TokenResponse {assetId (req), decimals, blockchain, symbol, price:number, priceUpdatedAt (req, date-time), contractAddress, coingeckoId}`.
- `POST /v0/quote` body `QuoteRequest`: required `swapType (EXACT_INPUT|EXACT_OUTPUT|FLEX_INPUT|ANY_INPUT), slippageTolerance (bps number), originAsset, depositType, destinationAsset, refundTo, refundType, recipientType`; plus `dry:boolean`, `amount` (integer string, smallest unit), `recipient`, `deadline`, `confidentiality` (`public` default; BASIC/ADVANCED request Confidential Intents), `referral`, `quoteWaitingTimeMs`, `appFees`, `insured`. Security: `X-API-Key` or `JWT-auth`.
  - With `dry:true` the response does NOT contain `depositAddress`, `timeWhenInactive`, `deadline`.
- Response `QuoteResponse {correlationId (req), timestamp, signature, quoteRequest (req), quote: Quote}`; `Quote` required: `amountIn, amountInFormatted, amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd, minAmountOut, timeEstimate`. 400 → `BadRequestResponse {message}`.
- Other paths present in the spec and **forbidden** in Nearesis: `/v0/deposit/submit`, `/v0/generate-intent`, `/v0/submit-intent`, `/v0/orders*`, `/v0/auth/*`, `/v0/account/*`, `/v0/status`, `/v0/any-input/withdrawals`. Allowlist = `GET /v0/tokens`, `POST /v0/quote` (dry only).

## CoinGecko

- Docs: `https://docs.coingecko.com/reference/coins-id-ohlc`, `.../coins-id-market-chart-range`, `.../authentication` (all HTTP 200).
- Public/Demo base `https://api.coingecko.com/api/v3`, Demo key header `x-cg-demo-api-key`; Pro base `https://pro-api.coingecko.com/api/v3`, header `x-cg-pro-api-key`. `GET /ping` public.
- Daily candles: `GET /coins/{id}/ohlc?vs_currency=usd&days=N` (array `[ts_ms, o, h, l, c]`), volume via `GET /coins/{id}/market_chart/range?vs_currency=usd&from=&to=`. Numeric limits per tier `TO_VERIFY`.

## BigQuery

- Dataset `bigquery-public-data.crypto_near_mainnet_us`. Identity, billing project and dataset location are **discovered at runtime** (D16). FND-20261110-003 observed location `us-east1`; FND-004 observed that ch.20's sample scans 2.61 TB unbounded and ~846 MB with `block_date` predicates on all three tables. Treat both as facts to re-verify, never constants.
- Local gcloud: ADC file present; active project configured. The adapter must read identity from the credential and from the finished job's `user_email`.

## Cube Core

- Image `cubejs/cube:v1.8.18` pinned by digest `sha256:d382326a0d2786242c3992f3dd462efbea82d07b2823ecdc83d619d2d6f5dcb7` (Docker Hub, published 2026-11-03; ≥ 3 days old). Docs `https://cube.dev/docs/product/deployment/core` (HTTP 200).

## ClickHouse

- Server `clickhouse/clickhouse-server:26.8.36.3` (base stack). `Decimal256(S)` holds 76 significant digits; `Int256`/`UInt256` exact. Docs `https://clickhouse.com/docs/sql-reference/data-types/decimal` (HTTP 200).
