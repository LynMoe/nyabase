#!/usr/bin/env bash

set -euo pipefail

POC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ID="${NYABASE_FULL_PROXY_POC_RUN_ID:-full-proxy-poc-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
ARTIFACT_DIR="${NYABASE_FULL_PROXY_POC_ARTIFACT_DIR:-$(cd "$POC_DIR/../../.." && pwd)/e2e/.runtime/$RUN_ID/full-proxies}"
export NYABASE_FULL_PROXY_POC_RUN_ID="$RUN_ID"
export NYABASE_FULL_PROXY_POC_ARTIFACT_DIR="$ARTIFACT_DIR"

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  bash "$POC_DIR/down.sh"
  cleanup_status=$?
  set -e
  if (( status == 0 && cleanup_status != 0 )); then status=$cleanup_status; fi
  exit "$status"
}
trap cleanup EXIT

bash "$POC_DIR/up.sh"
bash "$POC_DIR/probe.sh"
bash "$POC_DIR/down.sh"
trap - EXIT

echo "Full proxy isolation PoC passed"
echo "Evidence: $ARTIFACT_DIR/evidence.json"
echo "Cleanup: $ARTIFACT_DIR/cleanup-evidence.json"
