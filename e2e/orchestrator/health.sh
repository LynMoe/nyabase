#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

run_id="$(require_run_id "${1:-}")"
load_context "$run_id"
maybe_source_cephfs_fixture "$E2E_RUNTIME_ROOT"
require_control_plane_inputs "$E2E_PROFILE"

for path in \
  "${E2E_BASE_URL%/}/api/health/live" \
  "${E2E_BASE_URL%/}/api/health/ready"; do
  curl --fail --silent --show-error --max-time 10 \
    --cacert "$E2E_EDGE_CA_FILE" "$path" >/dev/null \
    || die "control-plane health failed at $path"
done

pg_isready -d "$E2E_DATABASE_URL" >/dev/null 2>&1 \
  || die "PostgreSQL health failed"
incus version >/dev/null 2>&1 \
  || die "Incus daemon health failed"
curl --fail --silent --show-error --max-time 10 \
  --cacert "$E2E_INCUS_CA_FILE" \
  --cert "$E2E_INCUS_CLIENT_CERT" \
  --key "$E2E_INCUS_CLIENT_KEY" \
  "${E2E_INCUS_API_ENDPOINT%/}/1.0" >/dev/null \
  || die "Incus HTTPS/mTLS health failed"

[[ -f "$E2E_SEED_STATE" && ! -L "$E2E_SEED_STATE" ]] \
  || die "seed state is missing"
node --input-type=module - "$E2E_SEED_STATE" "$E2E_RUN_ID" <<'NODE'
import { readFileSync } from 'node:fs';
const [path, runId] = process.argv.slice(2);
const state = JSON.parse(readFileSync(path, 'utf8'));
if (state.schemaVersion !== 3 || state.runId !== runId) throw new Error('seed identity mismatch');
if (state.image.sshdWithoutDhcp !== true) throw new Error('image no-DHCP proof missing');
if (state.image.assignmentId === undefined) throw new Error('image assignment fixture missing');
if (typeof state.image.createdByRun !== 'boolean'
  || typeof state.image.assignmentCreatedByRun !== 'boolean') {
  throw new Error('image ownership fixture missing');
}
if (state.preflight?.report?.controlReady !== true) throw new Error('preflight report missing');
if (state.blocked.gpu?.startsWith('BLOCKED:') !== true
  && state.blocked.gpu?.startsWith('PROVEN:') !== true) {
  throw new Error('GPU status must be BLOCKED: or PROVEN:');
}
if (state.blocked.cephfs?.startsWith('BLOCKED:') !== true
  && state.blocked.cephfs?.startsWith('ENABLED:') !== true) {
  throw new Error('CephFS status must be BLOCKED: or ENABLED:');
}
NODE

if [[ "$E2E_PROFILE" == "full" || "$E2E_PROFILE" == "recovery" ]]; then
  require_env E2E_NODE_EXPORTER_URL
  require_env E2E_NODE_EXPORTER_TOKEN
  metrics_ca="${E2E_NODE_EXPORTER_CA_FILE:-$E2E_EDGE_CA_FILE}"
  curl --fail --silent --show-error --max-time 10 \
    --cacert "$metrics_ca" \
    -H "Authorization: Bearer $E2E_NODE_EXPORTER_TOKEN" \
    "$E2E_NODE_EXPORTER_URL" >/dev/null \
    || die "authenticated node-exporter health failed"
fi

record_phase "$run_id" health passed "control plane, PostgreSQL, Incus HTTPS, seed, and telemetry are healthy"
log "health passed for $run_id"
