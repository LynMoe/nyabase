#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

maybe_source_lab_cluster
run_id="$(require_run_id "${1:-}")"
profile="${2:-${E2E_PROFILE:-smoke}}"
validate_profile "$profile"
set_server_registration_defaults "$run_id"
runtime_dir="$(runtime_dir_for "$run_id")"
install -d -m 0700 "$runtime_dir"
export E2E_RUNTIME_ROOT="$runtime_dir"
up_completed=false
cleanup_failed_up() {
  local rc=$?
  if [[ "$up_completed" != true ]]; then
    bash "$SCRIPT_DIR/provision-incus.sh" cleanup "$run_id" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup_failed_up EXIT INT TERM HUP
[[ -f "$runtime_dir/build.evidence" && ! -L "$runtime_dir/build.evidence" ]] \
  || die "build evidence is missing for runId $run_id; run build first"
rg -Fq "profile=$profile" "$runtime_dir/build.evidence" \
  || die "build evidence was produced for another profile; rebuild with $profile"

bash "$SCRIPT_DIR/sweep-incus-leftovers.sh" "$run_id"

E2E_RUN_ID="$run_id" bash "$SCRIPT_DIR/provision-incus.sh" apply "$run_id"
if [[ -n "${E2E_CEPHFS_FSID:-}" && -n "${E2E_CEPHFS_IDENTITY_KEY:-}" && -n "${E2E_CEPHFS_INCUS_POOL:-}" ]]; then
  umask 077
  {
    printf 'E2E_CEPHFS_FS_NAME=%s\n' "${E2E_CEPHFS_FS_NAME:-}"
    printf 'E2E_CEPHFS_FSID=%s\n' "${E2E_CEPHFS_FSID:-}"
    printf 'E2E_CEPHFS_CLIENT_NAME=%s\n' "${E2E_CEPHFS_CLIENT_NAME:-}"
    printf 'E2E_CEPHFS_CLUSTER_NAME=%s\n' "${E2E_CEPHFS_CLUSTER_NAME:-}"
    printf 'E2E_CEPHFS_MOUNT_PATH=%s\n' "${E2E_CEPHFS_MOUNT_PATH:-}"
    printf 'E2E_CEPHFS_QUOTA_BYTES=%s\n' "${E2E_CEPHFS_QUOTA_BYTES:-}"
    printf 'E2E_CEPHFS_MON_HOSTS=%s\n' "${E2E_CEPHFS_MON_HOSTS:-}"
    printf 'E2E_CEPHFS_META_POOL=%s\n' "${E2E_CEPHFS_META_POOL:-}"
    printf 'E2E_CEPHFS_DATA_POOL=%s\n' "${E2E_CEPHFS_DATA_POOL:-}"
    printf 'E2E_CEPHFS_INCUS_POOL=%s\n' "${E2E_CEPHFS_INCUS_POOL:-}"
    printf 'E2E_CEPHFS_IDENTITY_KEY=%s\n' "${E2E_CEPHFS_IDENTITY_KEY:-}"
    printf 'E2E_CEPHFS_KEY=%s\n' "${E2E_CEPHFS_KEY:-}"
  } > "$runtime_dir/cephfs-nbdev-test.env"
  chmod 600 "$runtime_dir/cephfs-nbdev-test.env"
fi
maybe_source_cephfs_fixture "$runtime_dir"
doctor_output="$(
  E2E_PROFILE="$profile" E2E_RUN_ID="$run_id" \
    bash "$SCRIPT_DIR/doctor.sh" "$run_id"
)"
capability_csv="$(awk -F= '/^E2E_CAPABILITIES=/{value=$2} END{print value}' <<<"$doctor_output")"
[[ -n "$capability_csv" ]] || die "doctor did not produce capabilities"

require_env NYABASE_CONFIG_FILE
[[ -f "$NYABASE_CONFIG_FILE" && ! -L "$NYABASE_CONFIG_FILE" ]] \
  || die "NYABASE_CONFIG_FILE must point to a regular file"
require_env E2E_DATABASE_URL
require_env E2E_BASE_URL
require_control_plane_inputs "$profile"
bootstrap_client_cert="$E2E_INCUS_CLIENT_CERT"
bootstrap_client_key="$E2E_INCUS_CLIENT_KEY"
connect_client_paths_file="$runtime_dir/incus-connect-client.paths"
if ! node "$SCRIPT_DIR/prepare-incus-connect-client.mjs" \
  "$runtime_dir" "$run_id" "$E2E_INCUS_SERVER_CERT_FINGERPRINT" \
  > "$connect_client_paths_file"; then
  rm -f "$connect_client_paths_file"
  die "failed to prepare the run-scoped Incus connect certificate"
fi
mapfile -t connect_client_paths < "$connect_client_paths_file"
rm -f "$connect_client_paths_file"
[[ "${#connect_client_paths[@]}" -eq 2 \
  && -f "${connect_client_paths[0]}" && ! -L "${connect_client_paths[0]}" \
  && -f "${connect_client_paths[1]}" && ! -L "${connect_client_paths[1]}" ]] \
  || die "Incus connect certificate helper returned invalid paths"
export E2E_INCUS_CONNECT_CLIENT_CERT="${connect_client_paths[0]}"
export E2E_INCUS_CONNECT_CLIENT_KEY="${connect_client_paths[1]}"
[[ "$E2E_INCUS_CLIENT_CERT" == "$bootstrap_client_cert" \
  && "$E2E_INCUS_CLIENT_KEY" == "$bootstrap_client_key" ]] \
  || die "Incus bootstrap certificate variables were changed while preparing connect material"

printf '%s\n' \
  'DATABASE_URL=E2E_DATABASE_URL' \
  'INCUS_CLIENT_CERT_FILE=E2E_INCUS_CLIENT_CERT' \
  'INCUS_CLIENT_KEY_FILE=E2E_INCUS_CLIENT_KEY' \
  'INCUS_CA_FILE=E2E_INCUS_CA_FILE' \
  'INCUS_CLIENT_CERT_PEM=E2E_INCUS_CLIENT_CERT contents' \
  'INCUS_CLIENT_KEY_PEM=E2E_INCUS_CLIENT_KEY contents' \
  'INCUS_CA_PEM=E2E_INCUS_CA_FILE contents' \
  'INCUS_SERVER_CERT_FINGERPRINT=E2E_INCUS_SERVER_CERT_FINGERPRINT' \
  'INCUS_IMAGE_ALIAS=E2E_INCUS_IMAGE_ALIAS' \
  'INCUS_IMAGE_FINGERPRINT=E2E_INCUS_IMAGE_FINGERPRINT' \
  'INCUS_IMAGE_SOURCE_URL=E2E_INCUS_IMAGE_SOURCE_URL' \
  'INCUS_PREFLIGHT_IMAGE_ALIAS=E2E_INCUS_PREFLIGHT_IMAGE_ALIAS' \
  'INCUS_PREFLIGHT_IMAGE_FINGERPRINT=E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT' \
  'INCUS_PREFLIGHT_POOL_NAME=E2E_INCUS_PREFLIGHT_POOL_NAME' \
  'INCUS_PREFLIGHT_SOURCE_SERVER=E2E_INCUS_PREFLIGHT_SOURCE_SERVER' \
  'INCUS_PREFLIGHT_EGRESS_URL=E2E_INCUS_PREFLIGHT_EGRESS_URL' \
  'NODE_EXPORTER_URL=E2E_NODE_EXPORTER_URL' \
  'NODE_EXPORTER_SERVER_CERT_FINGERPRINT=E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT' \
  'nodeMetricsToken=E2E_NODE_EXPORTER_TOKEN' \
  > "$runtime_dir/control-plane-wiring.evidence"
chmod 0600 "$runtime_dir/control-plane-wiring.evidence"

(
  cd "$E2E_ROOT"
  export_control_plane_environment "$profile"
  NODE_ENV=test pnpm --filter @nyabase/backend migration:run
)

bash "$SCRIPT_DIR/start-control-plane.sh" "$run_id" "$profile"

node "$SCRIPT_DIR/seed.mjs" "$runtime_dir" "$run_id" "$profile"
server_id="$(
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const state = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f-]{36}$/i.test(state.server?.id ?? "")) process.exit(1);
    process.stdout.write(state.server.id);
  ' "$runtime_dir/seed-state.json"
)" || die "seed state did not contain a valid registered server id"
export E2E_INCUS_SERVER_ID="$server_id"
# Ensure CephFS fixture (if present) is reflected in the durable context for the API runner.
maybe_source_cephfs_fixture "$runtime_dir"
capability_csv="${capability_csv},intent-reconciliation,exec-bridge,ssh-reachability"
if [[ -n "${E2E_SHARED_BACKEND_ID:-}" \
  && -n "${E2E_CEPHFS_FSID:-}" \
  && -n "${E2E_CEPHFS_IDENTITY_KEY:-}" \
  && -n "${E2E_CEPHFS_INCUS_POOL:-}" ]]; then
  case ",${capability_csv}," in
    *,cephfs-cluster,*) ;;
    *) capability_csv="${capability_csv},cephfs-cluster" ;;
  esac
fi
write_context "$run_id" "$profile" "$runtime_dir" "$capability_csv"
record_phase "$run_id" up passed "control plane, PostgreSQL, Incus seed, and capability evidence are ready"
up_completed=true
trap - EXIT INT TERM HUP
log "E2E run $run_id is ready; context: $(context_file_for "$run_id")"
