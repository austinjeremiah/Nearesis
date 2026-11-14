#!/bin/sh
# Clean-checkout certification (final directive s27, steps 1-7 and 20).
#
#   sh scripts/certify/clean-room.sh [options]
#
#   --setup-only         stop after migrations (steps 1-6): clone, install, build, disposable services, migrate from baseline
#   --gate G04           run one gate instead of the whole canonical suite (default: every test, serially, `pnpm accept --all`)
#   --live               pass --live to the suite (needs credentials, see --env-file; live tests are BLOCKED without them)
#   --env-file <file>    copy this .env into the CLONE root (never into the repo; the clone is deleted afterwards)
#   --toolchain-from <d> seed the clone's .toolchain from <d> (faster, but the toolchain is then not downloaded fresh;
#                        recorded in the manifest)
#   --out <dir>          manifest directory (default: NEARESIS_Build_Bible/reports/CLEAN-ROOM when present, else ./clean-room)
#   --continue           keep running later stages after a failed one (diagnosis only; the failed stage still makes the verdict FAIL)
#   --allow-dirty        certify HEAD although the working tree has uncommitted changes (verdict can then never be CERTIFIED)
#   --ref <commit>       certify this commit instead of HEAD (the clone is checked out at it)
#   --keep               keep the clone, the disposable stack and the evidence directory
#   --help
#
# What it does, in order (each stage is timed; a failed setup stage skips everything after it and is reported):
#   clone        git clone --no-hardlinks of the current HEAD into a temp dir; refuses a dirty source tree (so HEAD is what
#                is certified) unless --allow-dirty (the manifest then says so and the verdict can never be CERTIFIED)
#   prohibited   the tracked-path check of the clone (no Bible, directive, .env, keys, .data)
#   toolchain    scripts/bootstrap-toolchain.sh (checksum-verified Node, uv, Python)
#   install-js   pnpm install --frozen-lockfile        install-py   uv sync --frozen
#   build        pnpm typecheck, `pnpm -r --if-present build`, and the pinned OutLayer verifier wasm
#   services     disposable compose project `nearesis-clean` (fresh volumes, host ports 65xxx via scripts/ci/compose.local.yml,
#                so a running dev stack on 55432/56379/58123/59000/57233/4000 is never touched), roles applied
#   migrate      Postgres kernel + ingestion + analytics migrators against the empty databases (the known baseline)
#   suite        pnpm accept --all, strictly serial; evidence goes to a temp reports dir, never to the Bible
#   conformance  pnpm conformance with that evidence, then the PASS/FAIL/BLOCKED manifest (JSON + markdown)
#
# Steps 8-19 of s27 (extra tests, live integrations, fault injection, 1M/10M benchmarks, evaluation suite, live investigation,
# capsule, attestation, testnet readback, browser tests) are listed in the manifest as NOT_RUN/BLOCKED with the reason: this
# script proves the canonical suite on a clean checkout, nothing more. POSIX sh.
set -u

SETUP_ONLY=0; GATE=""; LIVE=0; ENV_FILE=""; TC_FROM=""; OUT=""; KEEP=0; ALLOW_DIRTY=0; CONTINUE=0; REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --setup-only) SETUP_ONLY=1 ;;
    --gate) GATE="$2"; shift ;;
    --live) LIVE=1 ;;
    --env-file) ENV_FILE="$2"; shift ;;
    --toolchain-from) TC_FROM="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --keep) KEEP=1 ;;
    --continue) CONTINUE=1 ;;
    --ref) REF="$2"; shift ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --help|-h) sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="$(cd "$HERE/../.." && pwd)"
SRC_REPO="$(git -C "$SRC_APP" rev-parse --show-toplevel)"
PROJECT="nearesis-clean"
[ "$PROJECT" != "nearesis" ] || { echo "refusing to operate on the default compose project" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nearesis-clean-room-XXXXXX")"
CLONE="$WORK/repo"; APP="$CLONE/nearesis-app"; LOGS="$WORK/logs"; REPORTS="$WORK/reports"; COORD="$WORK/coordination"
STAGES="$WORK/stages.jsonl"
mkdir -p "$LOGS" "$REPORTS" "$COORD"; : > "$STAGES"
[ -n "$OUT" ] || { if [ -d "$SRC_REPO/NEARESIS_Build_Bible/reports" ]; then OUT="$SRC_REPO/NEARESIS_Build_Bible/reports/CLEAN-ROOM"; else OUT="$PWD/clean-room"; fi; }
mkdir -p "$OUT"
echo "work dir: $WORK"

# Disposable stack ports (scripts/ci/compose.local.yml) and the env the package tests read.
PG=65432; RD=65379; CHH=65123; CHN=65000; TP=65233; CUBE=65400
export DATABASE_URL="postgres://nearesis:nearesis@127.0.0.1:$PG/nearesis"
export DATABASE_APP_URL="postgres://nearesis_app:nearesis_app@127.0.0.1:$PG/nearesis"
export REDIS_URL="redis://127.0.0.1:$RD" NEARESIS_REDIS_URL="redis://127.0.0.1:$RD"
export CLICKHOUSE_URL="http://127.0.0.1:$CHH" NEARESIS_CH_URL="http://127.0.0.1:$CHH"
export TEMPORAL_ADDRESS="127.0.0.1:$TP" NEARESIS_CUBE_URL="http://127.0.0.1:$CUBE"
export CUBE_CONTAINER="$PROJECT-cube-1" CI=true
export NEARESIS_COMPOSE_PROJECT="$PROJECT"
export NEARESIS_REPORTS_DIR="$REPORTS" NEARESIS_COORD_DIR="$COORD"

now() { date +%s; }
SETUP_FAILED=0
RAN_STACK=0
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

# stage <name> <description> <command...>: runs in $APP (after the clone exists), logs to $LOGS/<name>.log
stage() {
  name="$1"; desc="$2"; shift 2
  if [ "$SETUP_FAILED" = 1 ]; then
    printf '{"stage":"%s","status":"SKIPPED","seconds":0,"exitCode":null,"description":"%s","note":"an earlier setup stage failed"}\n' "$name" "$(json_escape "$desc")" >> "$STAGES"
    echo "SKIPPED  $name"; return 0
  fi
  echo "> $name"
  t0=$(now)
  if [ -d "$APP" ]; then ( cd "$APP" && "$@" ) > "$LOGS/$name.log" 2>&1; else ( "$@" ) > "$LOGS/$name.log" 2>&1; fi
  rc=$?
  secs=$(( $(now) - t0 ))
  if [ "$rc" = 0 ]; then st=PASS; else st=FAIL; [ "$CONTINUE" = 1 ] || SETUP_FAILED=1; tail -15 "$LOGS/$name.log"; fi
  printf '{"stage":"%s","status":"%s","seconds":%s,"exitCode":%s,"description":"%s","log":"logs/%s.log"}\n' "$name" "$st" "$secs" "$rc" "$(json_escape "$desc")" "$name" >> "$STAGES"
  echo "  $st (${secs}s)"
}

compose() {
  docker compose -p "$PROJECT" -f infrastructure/compose/docker-compose.yml -f infrastructure/compose/analytics.yml \
    -f scripts/ci/compose.local.yml "$@"
}
tools() { sh -c ". scripts/toolchain-env.sh && $*"; }

cleanup() {
  if [ "$RAN_STACK" = 1 ] && [ "$KEEP" = 0 ] && [ -d "$APP" ]; then
    ( cd "$APP" && compose down -v --remove-orphans ) > "$LOGS/teardown.log" 2>&1
  fi
  if [ "$KEEP" = 0 ]; then
    cp -R "$LOGS" "$OUT/logs-$STAMP" 2>/dev/null || true
    rm -rf "$WORK"
  else
    echo "kept: $WORK  (stack: docker compose -p $PROJECT ... down -v)"
  fi
}
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
trap cleanup EXIT

# ---- 1. clone ---------------------------------------------------------------------------------------------------------
DIRTY="$(git -C "$SRC_REPO" status --porcelain --untracked-files=no -- nearesis-app .github | head -3)"
SRC_DIRTY=0
if [ -n "$DIRTY" ]; then
  if [ "$ALLOW_DIRTY" = 1 ]; then SRC_DIRTY=1; else
    echo "refusing: the working tree has uncommitted changes, so a clone of HEAD would not be what you are certifying:" >&2
    echo "$DIRTY" >&2; echo "commit them, or pass --allow-dirty to certify HEAD anyway (verdict then cannot be CERTIFIED)" >&2
    SETUP_FAILED=1
    printf '{"stage":"clone","status":"FAIL","seconds":0,"exitCode":1,"description":"source tree is dirty","note":"uncommitted changes"}\n' >> "$STAGES"
  fi
fi
HEAD_SHA="$(git -C "$SRC_REPO" rev-parse "${REF:-HEAD}")"
stage clone "git clone --no-hardlinks, checked out at $HEAD_SHA" sh -c "git clone --no-hardlinks --quiet '$SRC_REPO' '$CLONE' && git -C '$CLONE' checkout -q '$HEAD_SHA'"
if [ "$SETUP_FAILED" = 0 ] && [ -n "$ENV_FILE" ]; then cp "$ENV_FILE" "$CLONE/.env"; fi
if [ "$SETUP_FAILED" = 0 ] && [ -n "$TC_FROM" ]; then mkdir -p "$APP/.toolchain" && cp -R "$TC_FROM/." "$APP/.toolchain/"; fi

# ---- 2. prerequisites + prohibited paths --------------------------------------------------------------------------------
prereq() {
  command -v git >/dev/null && command -v docker >/dev/null && command -v curl >/dev/null || { echo "git, docker and curl are required"; return 1; }
  docker info >/dev/null 2>&1 || { echo "the docker daemon is not reachable"; return 1; }
  for p in $PG $RD $CHH $CHN $TP 65234 $CUBE; do
    if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is already in use; the disposable stack needs 65432 65379 65123 65000 65233 65234 65400"; return 1; fi
  done
  docker ps -a --format '{{.Names}}' | grep -q "^$PROJECT-" && { echo "a previous $PROJECT stack exists; remove it with docker compose -p $PROJECT down -v"; return 1; }
  echo "prerequisites ok: $(docker --version)"
  echo "files hard-coding the dev stack ports (they would reach the dev stack, not the disposable one):"
  grep -rlE "127\.0\.0\.1:(55432|56379|58123|57233)" --include='*.ts' --include='*.mjs' --include='*.py' apps packages services plugins scripts tests 2>/dev/null | grep -v node_modules | head -40
  return 0
}
stage prerequisites "tools, docker daemon, free ports, no leftover stack" prereq
stage prohibited "no Bible, directive, env, key or runtime-data path is tracked in the clone" sh scripts/certify/check-prohibited.sh

# ---- 3-5. toolchain, install, build -------------------------------------------------------------------------------------
stage toolchain "checksum-verified project-local Node, uv and Python" sh scripts/bootstrap-toolchain.sh
stage install-js "pnpm install --frozen-lockfile" tools "pnpm install --frozen-lockfile"
stage install-py "uv sync --frozen" tools "uv sync --frozen"
stage build "typecheck, workspace builds, pinned OutLayer verifier wasm" tools "pnpm typecheck && pnpm -r --if-present build && pnpm exec tsx scripts/tests/ensure-wasm.ts"

# ---- 6-7. disposable services, migrate from baseline ---------------------------------------------------------------------
RAN_STACK=1
stage services "disposable compose project $PROJECT with fresh volumes on host ports 65xxx" sh -c "
  . scripts/toolchain-env.sh
  docker compose -p $PROJECT -f infrastructure/compose/docker-compose.yml -f infrastructure/compose/analytics.yml -f scripts/ci/compose.local.yml up -d --wait postgres redis clickhouse temporal cube &&
  docker compose -p $PROJECT -f infrastructure/compose/docker-compose.yml -f infrastructure/compose/analytics.yml -f scripts/ci/compose.local.yml exec -T postgres psql -U nearesis -d nearesis -tAc \"select rolname, rolsuper, rolbypassrls from pg_roles where rolname='nearesis_app'\" | grep -q '^nearesis_app|f|f\$'"
stage migrate "kernel, ingestion, analytics migrators against the empty databases" tools "pnpm --filter @nearesis/kernel migrate && pnpm --filter @nearesis/ingestion migrate && pnpm --filter @nearesis/analytics migrate"

# ---- 8. the canonical suite, serially -----------------------------------------------------------------------------------
if [ "$SETUP_ONLY" = 1 ]; then
  printf '{"stage":"suite","status":"NOT_RUN","seconds":0,"exitCode":null,"description":"setup-only run","note":"--setup-only"}\n' >> "$STAGES"
else
  SEL="--all"; [ -z "$GATE" ] || SEL="--gate $GATE"
  LIVEFLAG=""; [ "$LIVE" = 0 ] || LIVEFLAG="--live"
  # accept exits non-zero when a test fails; that is a result, not a setup failure, so the manifest stage still runs.
  stage suite "pnpm accept $SEL $LIVEFLAG (serial; evidence in a temp reports dir)" tools "NEARESIS_SESSION=clean-room pnpm accept $SEL $LIVEFLAG; true"
  [ "$SETUP_FAILED" = 1 ] || true
fi

# ---- 20. manifest ------------------------------------------------------------------------------------------------------
if [ -x "$APP/.toolchain/bin/pnpm" ] || [ -d "$APP/node_modules" ]; then
  ( cd "$APP" && sh -c ". scripts/toolchain-env.sh && pnpm exec tsx scripts/certify/clean-room-manifest.ts \
      --stages '$STAGES' --evidence '$REPORTS/TESTS' --out '$OUT' --stamp '$STAMP' --head '$HEAD_SHA' \
      --source-dirty $SRC_DIRTY --setup-only $SETUP_ONLY --live $LIVE --gate '${GATE}' \
      --toolchain-seeded $([ -n "$TC_FROM" ] && echo 1 || echo 0) --work '$WORK'" ) > "$LOGS/manifest.log" 2>&1
  mrc=$?
  tail -30 "$LOGS/manifest.log"
else
  # Nothing could be installed: still leave an honest manifest.
  { printf '{"verdict":"BLOCKED","head":"%s","reason":"setup failed before the toolchain was available","stages":[' "$HEAD_SHA"; paste -sd, "$STAGES"; printf ']}\n'; } > "$OUT/CLEAN-ROOM-$STAMP.json"
  echo "manifest: $OUT/CLEAN-ROOM-$STAMP.json (setup failed)"; mrc=1
fi
echo "stages:"; sed -E 's/.*"stage":"([^"]*)","status":"([^"]*)","seconds":([0-9]+).*/  \2\t\1\t\3s/' "$STAGES"
exit "$mrc"
