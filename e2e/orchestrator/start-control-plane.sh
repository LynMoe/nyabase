#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"
profile="${2:-${E2E_PROFILE:-smoke}}"
validate_profile "$profile"
if [[ -f "$(context_file_for "$run_id")" && ! -L "$(context_file_for "$run_id")" ]]; then
  load_context "$run_id"
fi
runtime_dir="$(runtime_dir_for "$run_id")"
export E2E_RUNTIME_ROOT="${E2E_RUNTIME_ROOT:-$runtime_dir}"
require_env E2E_BASE_URL
require_env E2E_EDGE_CA_FILE
require_control_plane_inputs "$profile"

health_url="${E2E_BASE_URL%/}/api/health/live"
if curl --fail --silent --show-error --max-time 5 \
  --cacert "$E2E_EDGE_CA_FILE" "$health_url" >/dev/null 2>&1; then
  log "control plane already healthy for $run_id"
  exit 0
fi

[[ "${E2E_BACKEND_AUTOSTART:-0}" == "1" ]] \
  || die "control plane is not healthy; set E2E_BACKEND_AUTOSTART=1 after preflight"

log "starting the built control plane"
install -m 0600 /dev/null "$runtime_dir/control-plane.log"
(
  cd "$E2E_ROOT"
  export_control_plane_environment "$profile"
  export NODE_ENV=test
  nohup pnpm --filter @nyabase/backend start \
    > "$runtime_dir/control-plane.log" 2>&1 &
  printf '%s\n' "$!" > "$runtime_dir/control-plane.pid"
)
chmod 0600 "$runtime_dir/control-plane.log" "$runtime_dir/control-plane.pid"
for _ in $(seq 1 90); do
  if curl --fail --silent --show-error --max-time 5 \
    --cacert "${E2E_EDGE_CA_FILE:-}" "$health_url" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --max-time 5 \
  --cacert "$E2E_EDGE_CA_FILE" "$health_url" >/dev/null 2>&1 \
  || die "control plane did not become healthy; inspect the private runtime log"
log "control plane is healthy for $run_id"
