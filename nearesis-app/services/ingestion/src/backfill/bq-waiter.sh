#!/bin/sh
# Waits until the next BigQuery quota reset (+5 min), then runs the budgeted BigQuery resume (ADR-20261110-005 rules).
# Usage: nohup sh bq-waiter.sh "2026-11-11T08:05:00Z" > .data/backfill/bigquery-resume.log 2>&1 &
TARGET="${1:-2026-11-11T08:05:00Z}"
T=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$TARGET" +%s 2>/dev/null || date -u -d "$TARGET" +%s)
echo "waiting for $TARGET (epoch $T)"
while [ "$(date -u +%s)" -lt "$T" ]; do sleep 30; done   # re-checks the wall clock, so machine sleep is harmless
cd "$(dirname "$0")/../../../.." || exit 1
. scripts/toolchain-env.sh
echo "start $(date -u +%FT%TZ)"
pnpm --filter @nearesis/ingestion backfill -- --resume --bigquery-only
echo "exit $? at $(date -u +%FT%TZ)"
