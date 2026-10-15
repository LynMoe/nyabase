#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"
load_context "$run_id"
output="$E2E_RUNTIME_ROOT/diagnose.evidence"
{
  printf '%s\n' '[incus]'
  incus version 2>&1 || true
  incus storage list 2>&1 || true
  incus list 2>&1 || true
  printf '%s\n' '[postgresql]'
  pg_isready -d "${E2E_DATABASE_URL:-invalid}" 2>&1 || true
  printf '%s\n' '[network]'
  ip -4 route show 2>&1 || true
  sysctl -a 2>/dev/null | rg 'net\.ipv4\.conf\..*rp_filter' || true
  nft -nn list ruleset 2>&1 || true
  printf '%s\n' '[control-plane]'
  curl --silent --show-error --max-time 10 \
    --cacert "${E2E_EDGE_CA_FILE:-}" \
    "${E2E_BASE_URL%/}/api/health/ready" 2>&1 || true
} > "$output"
chmod 0600 "$output"
record_phase "$run_id" diagnose passed "diagnostic evidence captured without credentials"
log "diagnostics captured at $output"
