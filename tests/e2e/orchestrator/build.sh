#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="${1:-${E2E_RUN_ID:-}}"
if [[ -n "$run_id" ]]; then validate_run_id "$run_id"; fi
profile="${2:-${E2E_PROFILE:-smoke}}"
validate_profile "$profile"
if [[ -n "$run_id" ]]; then
  require_control_plane_inputs "$profile"
fi

log "building common, node-exporter, frontend, and backend packages"
(
  cd "$E2E_ROOT"
  pnpm build
  pnpm --dir e2e validate
  pnpm --dir e2e typecheck
)

if [[ -n "$run_id" ]]; then
  runtime_dir="$(runtime_dir_for "$run_id")"
  install -d -m 0700 "$runtime_dir"
  printf '%s\n' \
    "build=passed" \
    "runtime=incus" \
    "profile=$profile" \
    "controlPlaneInputs=validated" \
    "observedAt=$(date -u +%FT%TZ)" \
    > "$runtime_dir/build.evidence"
  chmod 0600 "$runtime_dir/build.evidence"
  record_phase "$run_id" build passed "package build, E2E validation, and typecheck passed"
fi
