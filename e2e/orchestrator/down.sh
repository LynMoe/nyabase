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

bash "$SCRIPT_DIR/sweep-incus-leftovers.sh" "$run_id"

bash "$SCRIPT_DIR/stop-control-plane.sh" "$run_id"

node "$SCRIPT_DIR/leftover-inventory.mjs"

cleanup_run_owned_incus_connect_client "$E2E_RUNTIME_ROOT" "$run_id"
record_phase "$run_id" down passed "run resources removed and owned control plane stopped"
trap - EXIT INT TERM HUP
log "down passed for $run_id"
