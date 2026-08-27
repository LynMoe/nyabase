#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"
load_context "$run_id"
require_env E2E_BASE_URL
require_env E2E_ADMIN_USERNAME
require_env E2E_ADMIN_PASSWORD
require_env E2E_EDGE_CA_FILE

cleanup_exit() {
  local rc=$?
  local network_rc=0
  if bash "$SCRIPT_DIR/provision-incus.sh" cleanup "$run_id" >/dev/null 2>&1; then
    :
  else
    network_rc=$?
  fi
  if [[ "$rc" -eq 0 && "$network_rc" -ne 0 ]]; then
    rc="$network_rc"
  fi
  exit "$rc"
}
trap cleanup_exit EXIT INT TERM HUP

node "$SCRIPT_DIR/cleanup.mjs" "$run_id"

if [[ -s "$E2E_RUNTIME_ROOT/control-plane.pid" ]]; then
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
fi

node --input-type=module - "$E2E_RUN_ID" <<'NODE'
import { execFileSync } from 'node:child_process';
const runId = process.argv[2];
const output = execFileSync('incus', ['list', '--format', 'json'], { encoding: 'utf8' });
const resources = JSON.parse(output);
if (resources.some((entry) => entry.name?.startsWith(`e2e-${runId}`))) {
  throw new Error('Incus cleanup is incomplete');
}
NODE

cleanup_run_owned_incus_connect_client "$E2E_RUNTIME_ROOT" "$run_id"
record_phase "$run_id" down passed "run resources removed and owned control plane stopped"
trap - EXIT INT TERM HUP
log "down passed for $run_id"
