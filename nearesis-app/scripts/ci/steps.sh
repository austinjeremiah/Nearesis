#!/bin/sh
# Single source of truth for the CI steps. .github/workflows/ci.yml calls `sh scripts/ci/steps.sh <step>` once per
# step and scripts/ci/local-run.ts replays the very same list (`sh scripts/ci/steps.sh list`) on a fresh clone, so
# what passes locally is what runs on the GitHub runner. POSIX sh only.
#
# Environment knobs (all optional):
#   NEARESIS_COMPOSE_PROJECT   compose project name (-p); default is the name in the compose file
#   NEARESIS_COMPOSE_EXTRA     extra compose file (local validation uses it to move host ports)
#   NEARESIS_CI_REPORTS_DIR    where fixture acceptance evidence is written (default: a temp dir, never the repo)
set -eu
APP="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP"
NEARESIS_APP_ROOT="$APP"; export NEARESIS_APP_ROOT

STEPS="toolchain install-js install-py wasm playwright services-up db-roles migrate typecheck lint format test e2e pytest security vuln-scan boot deps accept-fixture"

compose() {
  set -- -f infrastructure/compose/docker-compose.yml -f infrastructure/compose/analytics.yml \
    ${NEARESIS_COMPOSE_EXTRA:+-f "$NEARESIS_COMPOSE_EXTRA"} "$@"
  if [ -n "${NEARESIS_COMPOSE_PROJECT:-}" ]; then set -- -p "$NEARESIS_COMPOSE_PROJECT" "$@"; fi
  docker compose "$@"
}
env_on() { . "$APP/scripts/toolchain-env.sh"; }

step="${1:-}"
case "$step" in
  list) for s in $STEPS; do echo "$s"; done ;;
  toolchain) sh scripts/bootstrap-toolchain.sh ;;
  install-js) env_on; pnpm install --frozen-lockfile ;;
  install-py) env_on; uv sync --frozen ;;
  # The verifier wasm is gitignored build output that capsule and integration tests read. Reproducible build with the pinned
  # Rust toolchain (installed here with rustup when absent; GitHub runners ship rustup); the result must match the policy pin.
  wasm) env_on; pnpm exec tsx scripts/tests/ensure-wasm.ts ;;
  playwright) env_on; pnpm --filter @nearesis/web exec playwright install --with-deps chromium ;;
  services-up)
    # Compose (not job `services:`): Temporal needs a command and Cube mounts repo files.
    # cube-live (host port 4001, real-data model) only serves live tests, which CI skips.
    compose up -d --wait postgres redis clickhouse temporal cube
    ;;
  db-roles)
    # The postgres container applies infrastructure/postgres/init/00-roles.sql on first boot. Re-apply only if absent
    # (the SQL is not idempotent), so this step is safe on a fresh or reused stack.
    has=$(compose exec -T postgres psql -U nearesis -d nearesis -tAc "select 1 from pg_roles where rolname='nearesis_app'")
    if [ "$has" = "1" ]; then echo "db-roles: nearesis_app already present"; else
      compose exec -T postgres psql -U nearesis -d nearesis -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/00-roles.sql
    fi
    compose exec -T postgres psql -U nearesis -d nearesis -tAc \
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname='nearesis_app'" | grep -q '^nearesis_app|f|f$'
    ;;
  migrate)
    # Fresh databases have no schema; the dev stack was migrated by hand. Each migrator is idempotent and owns its schema.
    env_on
    pnpm --filter @nearesis/kernel migrate
    pnpm --filter @nearesis/ingestion migrate
    pnpm --filter @nearesis/analytics migrate
    ;;
  typecheck) env_on; pnpm typecheck ;;
  lint) env_on; pnpm lint ;;
  format) env_on; pnpm format:check ;;
  # One workspace at a time: package suites share Postgres, Redis, ClickHouse and Temporal.
  test) env_on; CUBE_CONTAINER="${CUBE_CONTAINER:-${NEARESIS_COMPOSE_PROJECT:-nearesis}-cube-1}"; export CUBE_CONTAINER; pnpm -r --workspace-concurrency=1 --no-bail --if-present test ;;
  e2e) env_on; pnpm --filter @nearesis/build-monitor test:e2e ;;
  pytest) env_on; uv run pytest ;;
  security) env_on; pnpm security:all ;;
  # Pinned trivy (checksum-verified download) over every lockfile (pnpm, uv, npm, Cargo) and for secrets; the release policy decides.
  vuln-scan)
    env_on
    sh scripts/ci/install-trivy.sh
    pnpm exec tsx scripts/release/cli.ts scan-fs
    ;;
  boot) env_on; pnpm exec vitest run tests/boot/secret-scan.test.ts ;;
  # Test-dependency graph: acyclic, known IDs, gate order (reads tests/TEST_INDEX.json only), plus its unit test.
  deps) env_on; pnpm test:deps && pnpm exec vitest run scripts/tests/validate-deps.test.ts ;;
  accept-fixture)
    env_on
    # On GitHub, $RUNNER_TEMP/ci-reports is what the upload-artifact step collects (job-level env cannot use runner.*).
    R="${NEARESIS_CI_REPORTS_DIR:-${RUNNER_TEMP:+$RUNNER_TEMP/ci-reports}}"
    R="${R:-$(mktemp -d)/reports}"
    mkdir -p "$R" "$R/coordination"
    echo "fixture evidence dir: $R"
    NEARESIS_REPORTS_DIR="$R" NEARESIS_COORD_DIR="$R/coordination" pnpm ci:accept-fixture
    ;;
  *) echo "usage: steps.sh <$(echo $STEPS | tr ' ' '|')|list>" >&2; exit 2 ;;
esac
