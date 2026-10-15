#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"
load_context "$run_id"
node "$SCRIPT_DIR/release-proof.mjs" "$E2E_RUNTIME_ROOT" "$run_id" "$E2E_PROFILE"
record_phase "$run_id" release passed "runtime evidence and cleanup proof are complete"
log "release proof passed for $run_id"
