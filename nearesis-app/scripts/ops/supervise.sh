#!/usr/bin/env bash
# Manual process supervisor for the collectors. Started by hand; installs NO launchd/cron/login items.
#
#   scripts/ops/supervise.sh start  backfill|scheduler|all   run in the foreground (use a terminal/tmux; `all` runs both)
#   scripts/ops/supervise.sh status [backfill|scheduler]
#   scripts/ops/supervise.sh stop   backfill|scheduler|all   SIGTERM the supervisor; it forwards to the child, which releases its leases
#
# Guarantees: one supervisor per name (pidfile + liveness check), restart on crash with exponential backoff
# (5 s .. 5 min, reset after a run longer than 10 min), log rotation (copy-truncate at 20 MB, 5 files kept),
# SIGTERM/SIGINT forwarded to the child and waited for. Exit 0 of the backfill means "finished": it is not restarted.
# The scheduler is a loop, so any exit is restarted (exit 3 = another instance holds the lease: wait 60 s, retry).
set -u
APP="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${NEARESIS_SUPERVISE_DIR:-$APP/.data/supervisor}"
LOG_DIR="${NEARESIS_LOG_DIR:-$APP/.data/logs}"
MAX_LOG_BYTES="${NEARESIS_LOG_MAX_BYTES:-20971520}"
KEEP_LOGS="${NEARESIS_LOG_KEEP:-5}"
BACKOFF_MIN="${NEARESIS_BACKOFF_MIN:-5}"
BACKOFF_MAX="${NEARESIS_BACKOFF_MAX:-300}"
mkdir -p "$RUN_DIR" "$LOG_DIR"

command_for() {
  [ -n "${NEARESIS_SUPERVISE_CMD:-}" ] && { echo "$NEARESIS_SUPERVISE_CMD"; return 0; } # test hook
  case "$1" in
    backfill) echo "$APP/node_modules/.bin/tsx src/backfill/cli.ts --resume --explorer-only --explorer-max-minutes 0" ;;
    scheduler) echo "$APP/node_modules/.bin/tsx src/scheduler/cli.ts" ;;
    *) return 1 ;;
  esac
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_of() { cat "$RUN_DIR/$1.pid" 2>/dev/null; }
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

rotate_log() { # copy-truncate so the child's O_APPEND descriptor stays valid
  local f="$LOG_DIR/$1.log" size i
  size=$(wc -c <"$f" 2>/dev/null || echo 0)
  [ "$size" -lt "$MAX_LOG_BYTES" ] && return 0
  i=$KEEP_LOGS
  rm -f "$f.$i.gz"
  while [ "$i" -gt 1 ]; do
    [ -f "$f.$((i - 1)).gz" ] && mv "$f.$((i - 1)).gz" "$f.$i.gz"
    i=$((i - 1))
  done
  gzip -c "$f" >"$f.1.gz" && : >"$f"
}

supervise() {
  local rot name="$1" cmd pidfile child="" stopping=0 attempt=0 started code wait_s
  cmd="$(command_for "$name")" || { echo "unknown service: $name" >&2; return 2; }
  pidfile="$RUN_DIR/$name.pid"
  if alive "$(pid_of "$name")"; then
    echo "[$(stamp)] supervisor for $name already running (pid $(pid_of "$name")); refusing a second instance" >&2
    return 3
  fi
  echo $$ >"$pidfile"
  trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
  trap "rm -f '$pidfile'" EXIT
  cd "$APP/services/ingestion" || return 1
  # shellcheck disable=SC1091
  [ -n "${NEARESIS_SUPERVISE_CMD:-}" ] || . "$APP/scripts/toolchain-env.sh" >/dev/null 2>&1
  while [ "$stopping" -eq 0 ]; do
    rotate_log "$name"
    echo "[$(stamp)] supervisor: starting $name (attempt $((attempt + 1)))" >>"$LOG_DIR/$name.log"
    started=$(date +%s)
    # shellcheck disable=SC2086
    $cmd >>"$LOG_DIR/$name.log" 2>&1 &
    child=$!
    ( while sleep 30; do rotate_log "$name"; done ) &
    rot=$!
    # a trapped signal interrupts `wait` (status > 128) while the child may still be running: wait again until it is gone
    while :; do
      wait "$child"; code=$?
      alive "$child" || break
    done
    kill "$rot" 2>/dev/null; wait "$rot" 2>/dev/null
    child=""
    echo "[$(stamp)] supervisor: $name exited with code $code" >>"$LOG_DIR/$name.log"
    [ "$stopping" -eq 1 ] && break
    if [ "$name" = backfill ] && [ "$code" -eq 0 ]; then
      echo "[$(stamp)] supervisor: backfill finished (exit 0); not restarting" >>"$LOG_DIR/$name.log"
      break
    fi
    if [ "$code" -eq 3 ]; then
      wait_s=60 # another instance holds the lease
    else
      [ $(($(date +%s) - started)) -gt 600 ] && attempt=0
      attempt=$((attempt + 1))
      wait_s=$((BACKOFF_MIN * (1 << (attempt > 6 ? 6 : attempt - 1))))
      [ "$wait_s" -gt "$BACKOFF_MAX" ] && wait_s=$BACKOFF_MAX
    fi
    echo "[$(stamp)] supervisor: restarting $name in ${wait_s}s" >>"$LOG_DIR/$name.log"
    local i=0
    while [ "$i" -lt "$wait_s" ] && [ "$stopping" -eq 0 ]; do sleep 1; i=$((i + 1)); done
  done
}

status_one() {
  local p; p="$(pid_of "$1")"
  if alive "$p"; then echo "$1: supervised (pid $p), log $LOG_DIR/$1.log"; else echo "$1: not running"; fi
}

stop_one() {
  local p; p="$(pid_of "$1")"
  if alive "$p"; then kill -TERM "$p" && echo "$1: SIGTERM sent to supervisor $p"; else echo "$1: not running"; fi
}

targets() { [ "${1:-all}" = all ] && echo "backfill scheduler" || echo "$1"; }

case "${1:-}" in
  start)
    names=$(targets "${2:-}")
    set -- $names
    if [ "$#" -eq 1 ]; then supervise "$1"; exit $?; fi
    pids=""
    for n in "$@"; do "$0" start "$n" & pids="$pids $!"; done
    trap 'for p in $pids; do kill -TERM "$p" 2>/dev/null; done' TERM INT
    wait
    ;;
  status) for n in $(targets "${2:-}"); do status_one "$n"; done ;;
  stop) for n in $(targets "${2:-}"); do stop_one "$n"; done ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
