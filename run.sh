#!/usr/bin/env bash
# GMGN volume scanner control script
# usage: ./run.sh {start|stop|restart|status|logs|test|once|dry}
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PIDFILE="$DIR/data/scanner.pid"
LOG="$DIR/logs/scanner.log"
NODE="${NODE:-node}"
SCRIPT="src/scan.js"

mkdir -p logs data

is_running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE"))"
    return 0
  fi
  echo "starting..."
  nohup "$NODE" "$SCRIPT" >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 2
  if is_running; then
    echo "started (pid $(cat "$PIDFILE"))"
    echo "log: $LOG"
    tail -n 2 "$LOG"
  else
    echo "FAILED to start — last log lines:"
    tail -n 20 "$LOG"
    return 1
  fi
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  local pid
  pid="$(cat "$PIDFILE")"
  echo "stopping pid $pid..."
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  rm -f "$PIDFILE"
  echo "stopped"
}

status() {
  if is_running; then
    local pid
    pid="$(cat "$PIDFILE")"
    echo "RUNNING  pid $pid  uptime $(ps -o etime= -p "$pid" | tr -d ' ')"
    echo "--- config ---"
    grep -a "scanner up\|ch2 up" "$LOG" | tail -n 2
    echo "--- last 3 cycles ---"
    grep -a "scan sol" "$LOG" | tail -n 3
  else
    echo "STOPPED"
  fi
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    tail -f "$LOG" ;;
  test)    "$NODE" test/mock.test.mjs ;;
  once)    "$NODE" "$SCRIPT" --once ;;
  dry)     "$NODE" "$SCRIPT" --once --dry-run ;;
  *)
    echo "usage: ./run.sh {start|stop|restart|status|logs|test|once|dry}"
    exit 1
    ;;
esac
