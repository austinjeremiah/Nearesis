# Example requests

All requests send `Authorization: Bearer <token>`. In development get a token with `POST /v1/dev/login`. Responses are
saved next to this file (`*.json`); every refusal is an `ErrorResponse` (see `errors/`). `$API` is `http://localhost:4110`,
`$WS` a workspace id, `$TAB` a stable id for the browser tab group.

```bash
# sign in (non-production only)
curl -sX POST $API/v1/dev/login -H 'content-type: application/json' -d '{"oidcSubject":"analyst@example.test"}'

# create a workspace (idempotent)
curl -sX POST $API/v1/workspaces -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -H 'idempotency-key: ws-create-0001' \
  -d '{"objective":"NEAR Intents growth","networkScope":"mainnet_read","idempotencyKey":"ws-create-0001"}'   # -> workspace-created.json

# ask a question; the run starts, progress arrives on the event stream
curl -sX POST $API/v1/workspaces/$WS/questions -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"question":"Which chain pairs grew fastest over 30 days?","snapshotPolicy":"live","source":"live","budget":{"tokens":60000,"toolCalls":12,"usd":3}}'  # -> question-accepted.json

# follow progress (resume with Last-Event-ID); at most 6 streams per browser
curl -N $API/v1/workspaces/$WS/events -H "authorization: Bearer $T" -H "x-client-id: $TAB" -H 'last-event-id: 40'   # -> sse-session.txt

# investigations, sources and run detail
curl -s $API/v1/workspaces/$WS/runs    -H "authorization: Bearer $T"   # -> runs-list.json
curl -s $API/v1/workspaces/$WS/sources -H "authorization: Bearer $T"   # -> sources-list.json
curl -s $API/v1/runs/$RUN              -H "authorization: Bearer $T"

# apply a command with optimistic concurrency
curl -sX POST $API/v1/workspaces/$WS/commands -H "authorization: Bearer $T" -H 'content-type: application/json' -H 'if-match: "7"' \
  -d '{"apiVersion":"v1","commandId":"c2f8a1d4-5b6e-4f70-8a91-b2c3d4e5f607","commandType":"workspace.update_objective","payload":{"objective":"NEAR Intents growth, 90 days"},"expectedVersion":7}'   # -> command-accepted.json

# publish a capsule: cautionary statuses must be echoed in `acknowledge`, otherwise 422 ACKNOWLEDGEMENT_REQUIRED
curl -sX POST $API/v1/capsules/$CAPSULE/publish -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"acknowledge":["INSUFFICIENT_DATA","METHOD_NOT_VALIDATED"]}'

# spend and budget
curl -s $API/v1/workspaces/$WS/cost/burn           -H "authorization: Bearer $T"   # -> cost-burn.json
curl -s $API/v1/workspaces/$WS/cost/ledger?limit=50 -H "authorization: Bearer $T"  # -> cost-ledger.json
curl -s $API/v1/workspaces/$WS/cost/reconciliation  -H "authorization: Bearer $T"  # -> cost-reconciliation.json
curl -s $API/v1/cost/global                         -H "authorization: Bearer $T"  # owner/admin -> cost-global.json
curl -sX PUT $API/v1/workspaces/$WS/cost/policy -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"capUsd":25,"rates":{"ai_tokens":0.000003},"dimensionLimits":{"bigquery_bytes_billed":200000000000},"requirePriceFor":["bigquery_bytes_billed"]}'

# entity registry (ecosystem)
curl -s "$API/v1/entities/coverage?days=90" -H "authorization: Bearer $T"
curl -s "$API/v1/entities/ref-finance/metrics?from=2026-08-15&to=2026-11-12" -H "authorization: Bearer $T"
```

Rate limiting: a 429 carries `Retry-After` (seconds) and `retryAfterSeconds`; see `errors/rate-limited.json`.
