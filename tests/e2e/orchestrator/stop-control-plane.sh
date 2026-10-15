#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"
runtime_dir="$(runtime_dir_for "$run_id")"
export E2E_RUNTIME_ROOT="${E2E_RUNTIME_ROOT:-$runtime_dir}"

if [[ ! -s "$E2E_RUNTIME_ROOT/control-plane.pid" ]]; then
  log "no control-plane.pid for $run_id"
  exit 0
fi

pid="$(tr -d '\n' < "$E2E_RUNTIME_ROOT/control-plane.pid")"
if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
  command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$command_line" == *"backend"* || "$command_line" == *"dist/main.js"* ]] \
    || die "refusing to stop an unrelated process from the PID file"
  kill "$pid"
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
fi
rm -f "$E2E_RUNTIME_ROOT/control-plane.pid"
log "control plane stopped for $run_id"
