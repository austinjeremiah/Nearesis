#!/usr/bin/env bash
# Isolated chaos stack driver. Only ever operates on compose project `nearesis-chaos` (ports 64xxx, own volumes).
# usage: stack.sh up|down|status|restart <svc>|kill <svc>|start <svc>|pause <svc>|unpause <svc>|ports
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="nearesis-chaos"
FILE="$ROOT/infrastructure/compose/chaos.yml"
SERVICES="postgres redis clickhouse temporal cube"
dc() { docker compose -p "$PROJECT" -f "$FILE" "$@"; }
guard() { case " $SERVICES " in *" $1 "*) ;; *) echo "unknown service '$1'" >&2; exit 2;; esac; }
cmd="${1:-status}"; shift || true
case "$cmd" in
  up)     dc up -d --wait --no-build --pull never ${1:+"$@"} ;;
  down)   # volumes of THIS project only; the shared project is never addressed
          dc down -v --remove-orphans ;;
  status) dc ps --all ;;
  restart) guard "$1"; dc restart -t 3 "$1" ;;
  kill)   guard "$1"; dc kill -s "${2:-SIGKILL}" "$1" ;;
  start)  guard "$1"; dc start "$1" ;;
  pause)  guard "$1"; dc pause "$1" ;;
  unpause) guard "$1"; dc unpause "$1" ;;
  ports)  echo "postgres=64432 redis=64379 clickhouse_http=64123 clickhouse_native=64900 temporal=64233 temporal_ui=64234 cube=64400" ;;
  *) echo "usage: $0 up|down|status|restart|kill|start|pause|unpause|ports" >&2; exit 2 ;;
esac
