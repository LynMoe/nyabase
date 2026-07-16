#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/test/runtime/logs"

kill_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

kill_pid_file "$LOG_DIR/backend.pid"
kill_pid_file "$LOG_DIR/frontend.pid"
kill_pid_file "$LOG_DIR/ssh-proxy.pid"

pkill -f "node -r tsconfig-paths/register dist/main.js" 2>/dev/null || true
pkill -f "node dist/main.js" 2>/dev/null || true
pkill -f "vite.*--port 5173" 2>/dev/null || true
pkill -f "vite.*5173" 2>/dev/null || true
pkill -f "nyabase-ssh-proxy" 2>/dev/null || true

echo "Stopped local nyabase backend/frontend/ssh-proxy test processes."
