# Frontend changelog (backend changes since 11 Nov 2026)

For the frontend developer. Everything here is additive: no existing field, route or status code was removed or renamed.
Contract family version is now **1.8.0** (`CONTRACTS_VERSION`, `info.version` of `docs/api/openapi.json`). The machine
contract is `docs/api/openapi.json` (generate with `pnpm api:openapi`, check with `pnpm api:openapi:check`); state
semantics are in `STATES.md`, event semantics in `SSE.md`, samples in `examples/`.

## 1. One state and error taxonomy (new, v1.7.0)

- Exactly twelve states: `loading, partial, complete, stale, truncated, source_unavailable, permission_denied,
  rate_limited, insufficient_data, metric_uncertified, method_unvalidated, budget_exhausted` (`STATES.md`).
- `ErrorResponse.state` is a new **optional** field. Switch on it for refusals; `errorCode`, `reasonCode`, `retryable`,
  `nextAction` and the HTTP status are unchanged, so existing clients keep working. Validation failures, stale-version
  conflicts, not-found and internal errors carry no `state`.
- Data responses (chart data, query results, panels, findings) describe their completeness with `DataStateEnvelope`
  (`state`, `progress`, `truncation`, `freshness`, `reasonCode`, `nextAction`).
- `CANNOT_COMPUTE` results (NEAR Intents, unique users) are HTTP 200 with `status: "CANNOT_COMPUTE"`: render as `insufficient_data`.
- Reason codes `METRIC_UNCERTIFIED` and `METHOD_NOT_VALIDATED` map to their states as the metric-authoring and research
  stacks emit them; the capsule publish gate already requires acknowledging `METHOD_NOT_VALIDATED` and `INSUFFICIENT_DATA`.

## 2. Rate limiting and overload: 429 + Retry-After

- Every refusal for overload or rate limits is HTTP 429 with a `Retry-After` header (seconds) **and** `retryAfterSeconds`
  in the body. `state` is `rate_limited`. Back off for that long.
- Reason codes: `TENANT_QUEUE_FULL`, `GLOBAL_QUEUE_FULL`, `QUEUE_TIMEOUT`, `QUEUE_EVICTED` (investigation admission: at
  most 6 running and 16 queued per workspace owner, 128 queued overall, 5 s queue wait), `TOO_MANY_STREAMS`,
  `TOO_MANY_REQUESTS` (300 mutations per minute per client), `TOO_MANY_LOGINS` (20 per minute per IP).
- `POST /v1/workspaces/:id/questions` accepts `priority: "normal" | "low"` (default `normal`; you can only lower it).
- Mutating requests need `Content-Type: application/json`, an allowed `Origin` (same-origin always), and an
  uncompressed body of at most 1,000,000 bytes (`422 PAYLOAD_TOO_LARGE`, `UNSUPPORTED_CONTENT_TYPE`,
  `UNSUPPORTED_CONTENT_ENCODING`). JSON is parsed strictly: duplicate keys and `__proto__`-style keys are refused.
- `Idempotency-Key` (8-200 chars) makes writes replay-safe; `If-Match: "<version>"` gives optimistic concurrency (409
  `STALE_VERSION` with `lastStableRevision`).

## 3. `x-client-id` and the event stream

- Send a stable `x-client-id` (1-64 of `A-Za-z0-9._-`) on `GET /v1/workspaces/:id/events`. Streams are limited to **6 per
  browser** (credential + `x-client-id`); the 7th is a 429 with `Retry-After` before the stream starts. Reuse one id per
  browser, not per tab, so the limit counts what you intend.
- Resume with `Last-Event-ID` (or `?cursor=`): frames are `id: <seq>`, strictly increasing, deduplicate by id.
- New control frames: `coalesced` (a slow or far-behind client gets one aggregate instead of the backlog: refetch the
  views named in `byType`), `reload_required` (cursor invalid or expired; stream ends: reload, reconnect with
  `cursor=currentSeq`), `session_expired` (token expired or membership revoked; stream ends: re-authenticate, resume
  with `lastSeq`). Heartbeat comment `: ping` every 15 s of silence. Full catalogue: `SSE.md`.

## 4. Truncation and downsampling

- `ChartData.truncation` and `DataFrameEnvelope.truncation` appear only when the max-rows rule cut a result:
  `{ truncated: true, reason: "MAX_ROWS", method: truncate|min_max_bucket|lttb, requestedRows, returnedRows, maxRows }`.
  Label the panel (state `truncated`); never show it as complete. `requestedRowsIsLowerBound` means the count stopped early.

## 5. Freshness warnings and degraded sources

- `ChartData.freshnessWarning` (`SOURCE_DEGRADED | SOURCE_UNAVAILABLE | BREAKER_OPEN`, `asOf`, `staleSeconds`,
  `degradedSince`) is present while a source is degraded and the panel shows the last finalized snapshot. State `stale`;
  such values must never be published as current (`currentPublicationAllowed: false`).
- `GET /v1/workspaces/:id/sources` lists sources with `freshness: fresh | late | partial | stale | unavailable` and a watermark.

## 6. Progressive panels

- An approved canvas patch is applied panel by panel. Each panel emits `query.completed` frames with
  `data.status` `QUERYING -> READY | ERROR`, `data.index`/`data.total` and `data.panelId`; an `ERROR` carries `reasonCode`.
  Drive a skeleton per panel from these frames and refetch chart data when `READY` (also `panel.updated`).
- `GET /v1/workspaces/:id/runs` and `GET /v1/runs/:id` give investigation progress (`RunListItem.state`,
  tasks, budget usage `{total, spent, reserved}` per run).

## 7. Capsules: publish and acknowledge

- Publishing is explicit: `POST /v1/capsules/:id/publish` (also `POST /v1/publish` for the static bundle). A capsule with a
  cautionary status (`INSUFFICIENT_DATA`, `METHOD_NOT_VALIDATED`, `NOT_REPRODUCIBLE`, `VERIFICATION_FAILED`,
  `VERIFIED_STATE_FAILED`, blocked attestation) is published only when every such status is echoed in
  `acknowledge: string[]`. Otherwise `422 ACKNOWLEDGEMENT_REQUIRED` lists the missing ones in `details[].issue`.
- Viewers get `403 ROLE_CANNOT_PUBLISH`. `POST /v1/capsules/:id/unpublish` withdraws; `GET /v1/capsules/:id/publication`
  reads the record. Publishing emits `research.published` (SSE) and `publication.ready.v1`.
- `GET /v1/capsules/:id/verify` (reproduced or not), `/research-run` (research artifact), `/exports/*` (static files).
  Only published capsules are served by the public gateway.

## 8. Cost burn, forecast and the global ceiling

- `GET /v1/workspaces/:id/cost/burn`: spend, reserved, cap, burn fraction, per-resource usage and limit fractions,
  hard-stop state, block and alert counts. `forecast.label` is always `"projection"` and now carries
  `assumptions: string[]`: show them with the number. `confidence: "insufficient_data"` means no projection.
- `GET /v1/workspaces/:id/cost/ledger`: entries and blocked spends. **`usd` is `null` with `priceUnknown: true` when the
  price was unknown; it is never 0.** Do not sum `null` as 0 in the UI; show "price unknown".
- `GET /v1/workspaces/:id/cost/reconciliation`: reserved versus settled, estimate versus actual, stale reservations,
  unknown prices, and the check against the global ledger.
- `PUT /v1/workspaces/:id/cost/policy` (owner/admin): cap, per-resource `dimensionLimits`, `rates`, `paidOpsPermitted`,
  alert thresholds, and new `requirePriceFor` (dimensions refused with `PRICE_UNKNOWN` while no price is configured).
  `POST .../cost/resume` clears a hard stop.
- **One global USD 5 model-spend ceiling** for the whole system (not per workspace, not per day):
  `GET /v1/cost/global` (owner/admin) and `/v1/cost/global/reconciliation`. When it is reached every model call in every
  workspace is refused with `BUDGET_EXCEEDED` / `reasonCode: GLOBAL_CEILING` (state `budget_exhausted`); historical reads
  and non-model work keep working. The owner can lower the ceiling, never raise it.
- Budget refusal reason codes: `CAP_REACHED`, `DIMENSION_LIMIT`, `HARD_STOPPED`, `PAID_OP_NOT_PERMITTED`, `GLOBAL_CEILING`,
  `PRICE_UNKNOWN`. Threshold notifications (50/80/95/100 percent) arrive as `ops_alerts` with kinds `cost.threshold`
  and `cost.global_threshold`.

## 9. Collaboration WebSocket (Yjs)

- `GET /v1/workspaces/:id/collab/:scope/ws` upgrades to a WebSocket (JSON text frames: `sync`, `update`, `presence`,
  `ack`, `error`). Browsers cannot set headers on a WebSocket: send the token as the subprotocol
  `nearesis.bearer.<token>`. A revoked member's socket closes with code 4403, a bad frame with 4400. HTTP equivalents:
  `GET .../collab/:scope/state`, `POST .../collab/:scope/updates`, presence `GET|PUT`. Details: `x-websocket` in the spec.

## 10. New read APIs

- **Entity registry** (`/v1/entities`, `/registry`, `/coverage`, `/changes`, `/:id`, `/:id/mappings`, `/:id/metrics`,
  `/:id/unique-users`): classified versus unclassified coverage, time-versioned mappings. Unique users can be
  `CANNOT_COMPUTE`.
- **NEAR Intents** (`/v1/intents/*`, 18 read-only routes): typed `OK` / `CANNOT_COMPUTE` results with chart hints,
  coverage and provenance. USD the provider did not supply is counted in `swapsWithUnknownUsd`, never as zero.
- Monitoring, markers, lenses, notifications, snapshots, branches, merge proposals and evidence graph routes are
  documented in the spec; routes whose response is a service object without a zod contract yet are marked
  `x-schema-status: untyped`.

## 11. Session behaviour

- `POST /v1/session/revoke` (204) makes the token stop working on the next request; open event streams end with
  `session_expired` (`SESSION_REVOKED`). Every response carries `x-trace-id`; send your own `x-trace-id` (8-64 of
  `A-Za-z0-9-`) to correlate.
- `POST /v1/dev/login` exists only outside production.

## Not routed yet (planned, so not in the spec)

Metric catalogue and draft metric proposals (metric authoring), query planning, cost estimates for a query, and query
execution as standalone routes are not HTTP routes today. The spec lists only routes that exist: the drift test fails
the build if a route is added without being described, so regenerate the spec when they land.

## 2026-11-13 — lead hotfix in frontend-owned code (owner-approved)
- `packages/ui/src/shell/Sidebar.tsx`: run state `BLOCKED_SOURCE` (API since contracts 1.5.0) now renders "Source unavailable"; any other unknown run state renders "Unknown state" instead of crashing the sidebar. Commit above. Please keep or replace it with your own handling; the full twelve-state taxonomy is in `docs/api/STATES.md`.
- `packages/ui/src/styles/components.css` (owner-approved hotfix, 2026-11-13): `.nz-chat-scroll > * { flex-shrink: 0 }` so long run cards scroll instead of being squeezed and clipped (the approve button was unreachable). Keep or replace.

## 2026-11-13 — analytics panels for questions the certified catalogue cannot answer (contracts v1.8.0, additive)

The composer can now propose panels built from the typed analytics capabilities (`intents.analyze@1`, `entities.analyze@1`,
`accounts.analyze@1`), for example "swaps by status per week, how have refunds changed?". These are **analytics results
computed from certified source tables, not certified semantic metrics**. Never label them "certified".

- `PanelSpec.queryRef.resultKind` (optional): `"analytics_result"` marks such a panel; absent = a semantic query panel as before.
  `queryRef.hash` is the sha256 of the executed call (resolved window, defaults applied). `snapshotPolicy` is always `live`.
- `PanelSpec.analytics` (optional, present exactly when `resultKind` is `analytics_result`): `{ capability, analysis, label:
  "ANALYTICS_RESULT", certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC", sourceTables, metricVersion, coverageState }`.
  Show `label` as the panel's source badge (instead of LIVE/SYNTHETIC/certified) and `coverageState` as completeness.
  `panel.note` carries the same wording plus coverage and truncation for a plain-text fallback.
- **Panel data:** `GET /v1/analytics/panel/:hash` returns `AnalyticsPanelData` `{ chart, shape, provenance, cannotCompute, truncated }`
  (same chart/shape/provenance idea as `/api/semantic/panel/:hash`; `provenance.sourceLabel` is `"ANALYTICS"` and `provenance`
  also carries `call`, `coverage` (missing and incomplete days, never zero-filled), `caveats`, `definition`, `method`, `asOf`).
  The BFF `panelData()` in `apps/web/src/lib/server/semantic.ts` should branch on `panel.queryRef.resultKind === "analytics_result"`
  and call this route (the semantic `loadQuery` path answers 404 `QUERY_UNKNOWN` / a gateway rejection for these hashes).
  `cannotCompute` is set (HTTP 200, empty rows, `chart.freshness: "unavailable"`) when the source can no longer answer: render
  `insufficient_data` with `missing` and `explanation`, never a chart.
- Panel kinds used: `timeSeries` (line over time), `bar` (incl. stacked by `encoding.series`), `table`, `cohort`. All y fields carry a unit.
- The run's composer proposal (`tasks.result.proposal`) gains `analytics: [{ title, capability, analysis, outcome: OK | CANNOT_COMPUTE |
  REFUSED | FAILED, callHash, panelId, coverage, missing[] }]` and `skipped[]` (asks that produced no panel, with the reason).

## Interpretation: findings on the run (chat hotfix, 13 Nov 2026)

- `GET /v1/runs/:id` now returns `findings[]` and `interpretation {state: ready|unavailable|none, reason, findingCount}`. A finding is a grounded
  ResearchFinding (every number tied to a result row via `facts[].resultRef`) plus `kind`, `basis` (`observation` | `inference`), `status`
  (`supported | mixed | insufficient_data | cannot_compute`), `limitations[]`, `skepticNotes[]`, `panelIds[]`. Findings exist before the run is COMPLETE.
- New SSE event `finding.created` (data: runId, findingId, kind, basis, status, index, total); re-read the run for the text.
- Chat hotfix (apps/web run-conversation.ts, packages/ui AgentChatPanel): the run card renders findings (label, status, limitations, skeptic notes,
  source chips) instead of only "Added N panels"; `interpretation.state = unavailable` shows "Interpretation unavailable (reason)". Minimal; please restyle freely.
- `apps/web/src/lib/server/semantic.ts` `panelData()` (owner-approved hotfix, 2026-11-13): analytics panels (`queryRef.resultKind: "analytics_result"`; stored as `{kind: "analytics_call"}` in the query registry) are fetched from `GET /v1/analytics/panel/:hash` with the caller's session and mapped onto `PanelData` (certification `experimental`/`partial`, coverage missing/incomplete days in `gaps`, `cannotCompute` → 422 CANNOT_COMPUTE). Keep or replace with your own handling.

## 2026-11-13 — standalone frontend surface (contracts v1.9.0, additive)

New routes so a frontend outside the monorepo needs no gateway, ClickHouse or Redis access. All are in `docs/api/openapi.json` (tag `frontend`, plus two `session` routes) with zod contracts in `packages/contracts/src/frontend-api.ts`. Foreign and unknown workspaces are one 404 everywhere; reads and previews are open to viewers.

- `GET /v1/workspaces/:id/panels/:hash/data[?source=fixture|live]` returns `PanelDataResponse` for semantic AND analytics panels (`kind` says which, dispatched on the stored query). Fields: `chart`, `shape`, `provenance`, `gaps` (as the old BFF `panelData()`), plus `state` (twelve-state taxonomy), `coverage`, `freshness {state, sourceWatermark, sourceWatermarks, generatedAt}`, `rollupFreshness`, `cost {bytesEstimated, bytesBilled}`, `nullCount`, `partialCount`, `caveats`, `metricStatus`/`exploratory` for non-certified metrics, `cannotCompute`. An analytics call the source can no longer answer is HTTP 200 with `chart: null`, `state: "insufficient_data"` and `cannotCompute` (the BFF returned 422). The semantic layer (fixture or live) is inferred from the stored model hash unless `source` is given. `provenance.rawManifestHash` is null (fixture manifests are not resolved here). 404 `QUERY_UNKNOWN`: no stored query under that hash.
- `POST /v1/workspaces/:id/canvas/preview` (body: a `CanvasPatch`) is pure: no write, event, run or spend. 200 `{previewHash, baseRevision, operations, estimate}`; `estimate` has `queryCount`, `estimatedRows`, `bytesEstimated`, `estimatedCostUsd` (0: semantic and analytics reads are local ClickHouse/Cube with no per-query price; see `costBasis`), `atRiskPanelIds` (cap exceeded, unknown stored query, coverage unknown), `removedPanelIds` and one `queries[]` row per added or updated panel (`cached: true` means the gateway cache already holds it, so 0 bytes). 422 `PATCH_REJECTED` with per-operation issues otherwise.
- `POST /v1/workspaces/:id/questions/preview` plans without a run: no workflow, no budget row, no model call, no spend (`modelCalls: 0`, `spendUsd: 0`). Live questions: `planKind: "deterministic_composer"`, the exact plan the run will execute (one composer task, then a canvas apply that waits for approval). Fixture-source questions: `planKind: "director_model"`, `plan: null`, because the director is a model call. `canStart` and `blockers[]` (INSUFFICIENT_ROLE for viewers, BUDGET_BELOW_MINIMUM, ENGINE_UNAVAILABLE).
- `GET /v1/me`: `{principal, org, role, roles, permissions, workspaces}`. Global lists, all derived from the workspaces the caller can read (newest 100; `truncated` says so): `GET /v1/notifications[?unread=1&limit=]`, `GET /v1/approvals[?status=pending|all]`, `GET /v1/publications`, `GET /v1/metrics` (registry plus authored metrics of every workspace with `status`, `authoredIn`), `GET /v1/sources` (per provider: `state`, `watermark`, `lagSeconds`, `gapCount`, `coveragePct` over the last 90 days, per-dataset coverage, `recentErrors` from the quality-gap log, `rateLimit: null` because ingestion does not record rate limits; platform-wide, no tenant data).
- `POST /v1/workspaces/:id/collab/ticket {scope?}` returns a 30-second single-use ticket. Open the WebSocket with the subprotocol `nearesis.ticket.<ticket>` instead of a bearer token. Bound to the workspace (and scope, when given); burned by its first use, also a failed one.
- `GET /v1/auth/oidc/login` and `GET /v1/auth/oidc/callback`: generic OIDC (authorization code + PKCE S256). Off (404 `OIDC_NOT_CONFIGURED`) until `NEARESIS_OIDC_ISSUER`, `NEARESIS_OIDC_CLIENT_ID` and `NEARESIS_OIDC_REDIRECT_URI` are set (`NEARESIS_OIDC_CLIENT_SECRET`, `NEARESIS_OIDC_SCOPES`, `NEARESIS_OIDC_SUBJECT_CLAIM`, `NEARESIS_OIDC_AUTH_METHOD` optional). The registered redirect URI is the frontend's callback; its server forwards `code` and `state` to the API and receives the same session token as dev login (`{token, expiresAt, returnTo}`). The frontend must bind `state` to the browser that started the login (its own HttpOnly cookie). An identity with no user row is 403 `OIDC_USER_NOT_PROVISIONED`; nothing is auto-provisioned. Dev login is unchanged.
