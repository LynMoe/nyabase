#!/usr/bin/env bash
set -euo pipefail

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_RUNTIME_BASE="${E2E_RUNTIME_BASE:-$E2E_ROOT/e2e/.runtime}"

log() {
  printf '[e2e] %s\n' "$*"
}

die() {
  printf '[e2e] BLOCKED: %s\n' "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "missing runtime input: $name"
}

require_regular_file() {
  local name="$1"
  local path="${!name:-}"
  [[ -n "$path" && -f "$path" && ! -L "$path" && -r "$path" ]] \
    || die "$name must point to a readable regular file"
}

# Load optional CephFS shared-storage fixture from a run runtime directory.
# Secrets remain in the untracked runtime env file (mode 0600); never commit them.
# Onboarding trust tokens must not persist under the runtime tree (cleanup e2e
# scans every runtime file). Keep them outside the run directory and inject only
# into the process environment when needed.
maybe_source_trust_token() {
  local run_id="${1:-}"
  local token_file
  [[ -n "$run_id" ]] || return 0
  [[ -z "${E2E_INCUS_TRUST_TOKEN:-}" ]] || return 0
  for token_file in \
    "/tmp/nyabase-e2e-${run_id}-trust-token.env" \
    "/tmp/f855-trust-token.env"; do
    if [[ -f "$token_file" && ! -L "$token_file" ]]; then
      [[ "$(stat -c '%a' "$token_file")" == "600" ]] \
        || die "trust token file permissions must be 0600: $token_file"
      # shellcheck disable=SC1090
      set -a
      source "$token_file"
      set +a
      [[ -n "${E2E_INCUS_TRUST_TOKEN:-}" ]] || die "trust token file is empty: $token_file"
      return 0
    fi
  done
}

maybe_source_cephfs_fixture() {
  local runtime_dir="${1:-}"
  local env_file backend_id_file
  [[ -n "$runtime_dir" ]] || return 0
  env_file="$runtime_dir/cephfs-nbdev-test.env"
  backend_id_file="$runtime_dir/cephfs-backend.id"
  if [[ -f "$env_file" && ! -L "$env_file" ]]; then
    [[ "$(stat -c '%a' "$env_file")" == "600" ]] \
      || die "cephfs fixture permissions must be 0600: $env_file"
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^E2E_CEPHFS_[A-Z0-9_]+= ]] \
        || die "invalid cephfs fixture entry in $env_file"
    done < "$env_file"
    # shellcheck disable=SC1090
    set -a
    source "$env_file"
    set +a
  fi
  if [[ -z "${E2E_SHARED_BACKEND_ID:-}" \
    && -f "$backend_id_file" && ! -L "$backend_id_file" ]]; then
    E2E_SHARED_BACKEND_ID="$(tr -d '[:space:]' < "$backend_id_file")"
    export E2E_SHARED_BACKEND_ID
  fi
}

cleanup_run_owned_incus_connect_client() {
  local runtime_root="$1"
  local run_id="$2"
  local ownership="$runtime_root/incus-connect-client-ownership"
  local certificate="$runtime_root/incus-connect-client.crt"
  local private_key="$runtime_root/incus-connect-client.key"

  if [[ ! -e "$ownership" && ! -L "$ownership" \
    && ! -e "$certificate" && ! -L "$certificate" \
    && ! -e "$private_key" && ! -L "$private_key" ]]; then
    return 0
  fi
  [[ -f "$ownership" && ! -L "$ownership" && -r "$ownership" ]] \
    || die "Incus connect certificate ownership metadata is invalid"
  [[ -f "$certificate" && ! -L "$certificate" \
    && -f "$private_key" && ! -L "$private_key" ]] \
    || die "Incus connect certificate files are invalid"

  local owner_run_id owner_certificate owner_private_key
  owner_run_id="$(awk -F= '$1 == "run_id" { print $2; exit }' "$ownership")"
  owner_certificate="$(awk -F= '$1 == "client_cert" { print $2; exit }' "$ownership")"
  owner_private_key="$(awk -F= '$1 == "client_key" { print $2; exit }' "$ownership")"
  [[ "$owner_run_id" == "$run_id" \
    && "$owner_certificate" == "$certificate" \
    && "$owner_private_key" == "$private_key" ]] \
    || die "Incus connect certificate is not owned by this run"

  rm -f -- "$certificate" "$private_key" "$ownership"
}

require_fingerprint() {
  local name="$1"
  local value="${!name:-}"
  [[ "$value" =~ ^[0-9A-Fa-f:]{32,95}$ ]] \
    || die "$name must be a hexadecimal certificate fingerprint"
}

require_image_fingerprint() {
  local name="$1"
  local value="${!name:-}"
  [[ "$value" =~ ^[0-9a-fA-F]{64}$ ]] \
    || die "$name must be a 64-character image fingerprint"
}

require_control_plane_inputs() {
  local profile="${1:-${E2E_PROFILE:-smoke}}"
  validate_profile "$profile"

  require_env NYABASE_CONFIG_FILE
  [[ -f "$NYABASE_CONFIG_FILE" && ! -L "$NYABASE_CONFIG_FILE" && -r "$NYABASE_CONFIG_FILE" ]] \
    || die "NYABASE_CONFIG_FILE must point to a readable regular file"

  for name in \
    E2E_BASE_URL \
    E2E_ADMIN_USERNAME \
    E2E_ADMIN_PASSWORD \
    E2E_DATABASE_URL \
    E2E_EDGE_CA_FILE \
    E2E_INCUS_API_ENDPOINT \
    E2E_INCUS_SERVER_CERT_FINGERPRINT \
    E2E_INCUS_CLIENT_CERT \
    E2E_INCUS_CLIENT_KEY \
    E2E_INCUS_CA_FILE \
    E2E_INCUS_TRUST_TOKEN \
    E2E_INCUS_DIR_POOL \
    E2E_INCUS_LVM_POOL \
    E2E_INCUS_PARENT_INTERFACE \
    E2E_INCUS_ROUTED_SUBNET \
    E2E_INCUS_ROUTED_ADDRESS \
    E2E_INCUS_SPOOF_ADDRESS \
    E2E_INCUS_ROUTED_GATEWAY \
    E2E_INCUS_PROBE_ADDRESS \
    E2E_INCUS_IMAGE_SOURCE_URL \
    E2E_INCUS_IMAGE_REMOTE \
    E2E_INCUS_IMAGE_ALIAS \
    E2E_INCUS_IMAGE_FINGERPRINT \
    E2E_INCUS_IMAGE_NO_DHCP \
    E2E_INCUS_PREFLIGHT_IMAGE_ALIAS \
    E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT \
    E2E_INCUS_PREFLIGHT_POOL_NAME \
    E2E_INCUS_PREFLIGHT_EGRESS_URL \
    E2E_INCUS_PREFLIGHT_SOURCE_SERVER \
    E2E_NODE_EXPORTER_URL \
    E2E_NODE_EXPORTER_TOKEN \
    E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT \
    E2E_SSH_PRIVATE_KEY_FILE \
    E2E_SSH_KNOWN_HOSTS \
    E2E_SSH_USER; do
    require_env "$name"
  done

  for name in \
    E2E_EDGE_CA_FILE \
    E2E_INCUS_CLIENT_CERT \
    E2E_INCUS_CLIENT_KEY \
    E2E_INCUS_CA_FILE \
    E2E_SSH_PRIVATE_KEY_FILE \
    E2E_SSH_KNOWN_HOSTS; do
    require_regular_file "$name"
  done
  if [[ -n "${E2E_NODE_EXPORTER_CA_FILE:-}" ]]; then
    require_regular_file E2E_NODE_EXPORTER_CA_FILE
  fi

  require_fingerprint E2E_INCUS_SERVER_CERT_FINGERPRINT
  require_fingerprint E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT
  require_image_fingerprint E2E_INCUS_IMAGE_FINGERPRINT
  require_image_fingerprint E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT

  [[ "$E2E_BASE_URL" == https://* ]] \
    || die "E2E_BASE_URL must be an HTTPS URL"
  [[ "$E2E_INCUS_API_ENDPOINT" == https://* ]] \
    || die "E2E_INCUS_API_ENDPOINT must be an HTTPS URL"
  [[ "${E2E_INCUS_IMAGE_NO_DHCP:-}" == "1" ]] \
    || die "E2E_INCUS_IMAGE_NO_DHCP=1 is required for the SSHD image contract"
  [[ "$E2E_INCUS_IMAGE_SOURCE_URL" == https://* ]] \
    || die "E2E_INCUS_IMAGE_SOURCE_URL must be an HTTPS simplestreams URL"
  [[ "$E2E_INCUS_PREFLIGHT_SOURCE_SERVER" == https://* ]] \
    || die "E2E_INCUS_PREFLIGHT_SOURCE_SERVER must be an HTTPS simplestreams URL"
  [[ "$E2E_INCUS_PREFLIGHT_EGRESS_URL" == https://* ]] \
    || die "E2E_INCUS_PREFLIGHT_EGRESS_URL must be an HTTPS URL"
  [[ "$E2E_NODE_EXPORTER_URL" == https://* ]] \
    || die "E2E_NODE_EXPORTER_URL must be an HTTPS URL"

  if [[ "$profile" == "full" || "$profile" == "recovery" ]]; then
    for name in E2E_NODE_EXPORTER_UNIT E2E_ENABLE_OUTAGE_MUTATION; do
      require_env "$name"
    done
    [[ "$E2E_ENABLE_OUTAGE_MUTATION" == "1" ]] \
      || die "E2E_ENABLE_OUTAGE_MUTATION=1 is required for $profile metrics outage evidence"
  fi
}

export_control_plane_environment() {
  local profile="${1:-${E2E_PROFILE:-smoke}}"
  require_control_plane_inputs "$profile"

  local client_cert_pem client_key_pem ca_pem
  client_cert_pem="$(<"$E2E_INCUS_CLIENT_CERT")"
  client_key_pem="$(<"$E2E_INCUS_CLIENT_KEY")"
  ca_pem="$(<"$E2E_INCUS_CA_FILE")"
  [[ -n "$client_cert_pem" && -n "$client_key_pem" && -n "$ca_pem" ]] \
    || die "Incus client certificate, key, and CA files must not be empty"

  export DATABASE_URL="$E2E_DATABASE_URL"
  export NYABASE_CONFIG_FILE
  export ADMIN_INIT_PASSWORD="$E2E_ADMIN_PASSWORD"
  export INCUS_CLIENT_CERT_FILE="$E2E_INCUS_CLIENT_CERT"
  export INCUS_CLIENT_KEY_FILE="$E2E_INCUS_CLIENT_KEY"
  export INCUS_CA_FILE="$E2E_INCUS_CA_FILE"
  export INCUS_CLIENT_CERT_PEM="$client_cert_pem"
  export INCUS_CLIENT_KEY_PEM="$client_key_pem"
  export INCUS_CA_PEM="$ca_pem"
  export INCUS_SERVER_CERT_FINGERPRINT="$E2E_INCUS_SERVER_CERT_FINGERPRINT"
  export INCUS_IMAGE_ALIAS="$E2E_INCUS_IMAGE_ALIAS"
  export INCUS_IMAGE_FINGERPRINT="$E2E_INCUS_IMAGE_FINGERPRINT"
  export INCUS_IMAGE_SOURCE_URL="$E2E_INCUS_IMAGE_SOURCE_URL"
  export INCUS_IMAGE_REMOTE="$E2E_INCUS_IMAGE_REMOTE"
  export INCUS_IMAGE_NO_DHCP="$E2E_INCUS_IMAGE_NO_DHCP"
  export INCUS_PREFLIGHT_IMAGE_ALIAS="$E2E_INCUS_PREFLIGHT_IMAGE_ALIAS"
  export INCUS_PREFLIGHT_IMAGE_FINGERPRINT="$E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT"
  export INCUS_PREFLIGHT_POOL_NAME="$E2E_INCUS_PREFLIGHT_POOL_NAME"
  export INCUS_PREFLIGHT_ADDRESS="$E2E_INCUS_PROBE_ADDRESS"
  export INCUS_PREFLIGHT_SOURCE_SERVER="$E2E_INCUS_PREFLIGHT_SOURCE_SERVER"
  export INCUS_PREFLIGHT_EGRESS_URL="$E2E_INCUS_PREFLIGHT_EGRESS_URL"
  export NODE_EXPORTER_URL="$E2E_NODE_EXPORTER_URL"
  export NODE_EXPORTER_TOKEN="$E2E_NODE_EXPORTER_TOKEN"
  export NODE_EXPORTER_SERVER_CERT_FINGERPRINT="$E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT"
  local ca_bundle="${E2E_RUNTIME_ROOT:-$E2E_RUNTIME_BASE}/control-plane-ca-bundle.pem"
  install -d -m 0700 "$(dirname "$ca_bundle")"
  cat "$E2E_INCUS_CA_FILE" > "$ca_bundle"
  if [[ -n "${E2E_NODE_EXPORTER_CA_FILE:-}" \
    && "$E2E_NODE_EXPORTER_CA_FILE" != "$E2E_INCUS_CA_FILE" ]]; then
    cat "$E2E_NODE_EXPORTER_CA_FILE" >> "$ca_bundle"
  fi
  chmod 0600 "$ca_bundle"
  export NODE_EXTRA_CA_CERTS="$ca_bundle"
}

validate_run_id() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{5,63}$ ]] \
    || die "runId must match ^[a-z0-9][a-z0-9-]{5,63}$"
}

validate_profile() {
  case "${1:-}" in
    smoke|core|full|recovery) ;;
    *) die "unknown profile: ${1:-}" ;;
  esac
}

set_server_registration_defaults() {
  local run_id="$1"
  local slug="e2e-${run_id}"
  if ((${#slug} > 64)); then
    slug="e2e-${run_id:0:43}-${run_id: -16}"
  fi
  export E2E_INCUS_SERVER_SLUG="${E2E_INCUS_SERVER_SLUG:-$slug}"
  export E2E_INCUS_LAN_RESERVED_IPS="${E2E_INCUS_LAN_RESERVED_IPS:-}"
  export E2E_INCUS_DNS_SERVERS="${E2E_INCUS_DNS_SERVERS:-}"
}

resolve_run_id() {
  local value="${1:-${E2E_RUN_ID:-}}"
  if [[ -z "$value" ]]; then
    value="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 3)"
  fi
  validate_run_id "$value"
  printf '%s\n' "$value"
}

require_run_id() {
  local value="${1:-${E2E_RUN_ID:-}}"
  [[ -n "$value" ]] || die "an explicit runId or E2E_RUN_ID is required"
  validate_run_id "$value"
  printf '%s\n' "$value"
}

runtime_dir_for() {
  printf '%s/%s\n' "$E2E_RUNTIME_BASE" "$1"
}

nft_table_for_run() {
  local run_id="$1"
  validate_run_id "$run_id"
  local compact="${run_id#incus-}"
  printf 'nbe2e_%s\n' "${compact//-/}"
}

context_file_for() {
  printf '%s/context.env\n' "$(runtime_dir_for "$1")"
}

write_context() {
  local run_id="$1" profile="$2" runtime_dir="$3" capabilities="$4"
  install -d -m 0700 "$runtime_dir"
  local tmp="$runtime_dir/.context.$$.tmp"
  umask 077
  {
    printf 'E2E_RUN_ID=%q\n' "$run_id"
    printf 'E2E_PROFILE=%q\n' "$profile"
    printf 'E2E_RUNTIME_ROOT=%q\n' "$runtime_dir"
    printf 'E2E_SEED_STATE=%q\n' "$runtime_dir/seed-state.json"
    printf 'E2E_CAPABILITIES=%q\n' "$capabilities"
    printf 'NYABASE_CONFIG_FILE=%q\n' "${NYABASE_CONFIG_FILE:-}"
    for name in \
      E2E_DATABASE_URL \
      E2E_BASE_URL \
      E2E_ADMIN_USERNAME \
      E2E_ADMIN_PASSWORD \
      E2E_EDGE_CA_FILE \
      E2E_EDGE_CLIENT_CERT \
      E2E_EDGE_CLIENT_KEY \
      E2E_INCUS_API_ENDPOINT \
      E2E_INCUS_SERVER_ID \
      E2E_INCUS_SERVER_SLUG \
      E2E_INCUS_LAN_RESERVED_IPS \
      E2E_INCUS_DNS_SERVERS \
      E2E_INCUS_SERVER_CERT_FINGERPRINT \
      E2E_INCUS_CLIENT_CERT \
      E2E_INCUS_CLIENT_KEY \
      E2E_INCUS_CA_FILE \
      E2E_INCUS_DIR_POOL \
      E2E_INCUS_LVM_POOL \
      E2E_INCUS_DIR_QUOTA_PROOF \
      E2E_INCUS_LVM_BLOCK_PROOF \
      E2E_INCUS_PARENT_INTERFACE \
      E2E_INCUS_ROUTED_SUBNET \
      E2E_INCUS_ALLOCATION_CIDR \
      E2E_INCUS_ROUTED_ADDRESS \
      E2E_INCUS_SPOOF_ADDRESS \
      E2E_INCUS_ROUTED_GATEWAY \
      E2E_INCUS_PROBE_ADDRESS \
      E2E_INCUS_IMAGE_SOURCE_URL \
      E2E_INCUS_IMAGE_REMOTE \
      E2E_INCUS_IMAGE_ALIAS \
      E2E_INCUS_IMAGE_FINGERPRINT \
      E2E_INCUS_IMAGE_NO_DHCP \
      E2E_INCUS_PREFLIGHT_IMAGE_ALIAS \
      E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT \
      E2E_INCUS_PREFLIGHT_POOL_NAME \
      E2E_INCUS_PREFLIGHT_EGRESS_URL \
      E2E_INCUS_PREFLIGHT_SOURCE_SERVER \
      E2E_NODE_EXPORTER_URL \
      E2E_NODE_EXPORTER_TOKEN \
      E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT \
      E2E_NODE_EXPORTER_CA_FILE \
      E2E_NODE_EXPORTER_UNIT \
      E2E_ENABLE_OUTAGE_MUTATION \
      E2E_ENABLE_NETWORK_MUTATION \
      E2E_SHARED_BACKEND_ID \
      E2E_CEPHFS_FS_NAME \
      E2E_CEPHFS_FSID \
      E2E_CEPHFS_CLIENT_NAME \
      E2E_CEPHFS_CLUSTER_NAME \
      E2E_CEPHFS_MOUNT_PATH \
      E2E_CEPHFS_QUOTA_BYTES \
      E2E_CEPHFS_MON_HOSTS \
      E2E_CEPHFS_META_POOL \
      E2E_CEPHFS_DATA_POOL \
      E2E_CEPHFS_INCUS_POOL \
      E2E_CEPHFS_IDENTITY_KEY \
      E2E_CEPHFS_KEY \
      E2E_INCUS_KEY_ENCRYPTION_SECRET \
      E2E_SSH_PRIVATE_KEY_FILE \
      E2E_SSH_KNOWN_HOSTS \
      E2E_SSH_USER \
      E2E_GPU_PCI_PROOF \
      E2E_GPU_PCI_ADDRESS \
      E2E_GPU_PEER_HOST \
      E2E_GPU_PEER_SERVER_ID; do
      printf '%s=%q\n' "$name" "${!name:-}"
    done
  } > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$(context_file_for "$run_id")"
}

load_context() {
  local run_id="$1"
  local path
  path="$(context_file_for "$run_id")"
  [[ -f "$path" && ! -L "$path" ]] || die "no context for runId $run_id"
  [[ "$(stat -c '%a' "$path")" == "600" ]] || die "context permissions must be 0600"
  # The file is generated by write_context and contains only shell assignments.
  # Reject unexpected syntax before sourcing it.
  while IFS= read -r line; do
    [[ "$line" =~ ^(E2E_[A-Z0-9_]+|NYABASE_CONFIG_FILE)=.*$ ]] \
      || die "invalid context entry"
  done < "$path"
  # shellcheck disable=SC1090
  source "$path"
  export E2E_RUN_ID E2E_PROFILE E2E_RUNTIME_ROOT E2E_SEED_STATE E2E_CAPABILITIES
  export NYABASE_CONFIG_FILE
  for name in \
    E2E_DATABASE_URL \
    E2E_BASE_URL \
    E2E_ADMIN_USERNAME \
    E2E_ADMIN_PASSWORD \
    E2E_EDGE_CA_FILE \
    E2E_EDGE_CLIENT_CERT \
    E2E_EDGE_CLIENT_KEY \
    E2E_INCUS_API_ENDPOINT \
    E2E_INCUS_SERVER_ID \
    E2E_INCUS_SERVER_SLUG \
    E2E_INCUS_LAN_RESERVED_IPS \
    E2E_INCUS_DNS_SERVERS \
    E2E_INCUS_SERVER_CERT_FINGERPRINT \
    E2E_INCUS_CLIENT_CERT \
    E2E_INCUS_CLIENT_KEY \
    E2E_INCUS_CA_FILE \
    E2E_INCUS_TRUST_TOKEN \
    E2E_INCUS_DIR_POOL \
    E2E_INCUS_LVM_POOL \
    E2E_INCUS_DIR_QUOTA_PROOF \
    E2E_INCUS_LVM_BLOCK_PROOF \
    E2E_INCUS_PARENT_INTERFACE \
    E2E_INCUS_ROUTED_SUBNET \
    E2E_INCUS_ROUTED_ADDRESS \
    E2E_INCUS_SPOOF_ADDRESS \
    E2E_INCUS_ROUTED_GATEWAY \
    E2E_INCUS_PROBE_ADDRESS \
    E2E_INCUS_IMAGE_SOURCE_URL \
    E2E_INCUS_IMAGE_REMOTE \
    E2E_INCUS_IMAGE_ALIAS \
    E2E_INCUS_IMAGE_FINGERPRINT \
    E2E_INCUS_IMAGE_NO_DHCP \
    E2E_INCUS_PREFLIGHT_IMAGE_ALIAS \
    E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT \
    E2E_INCUS_PREFLIGHT_POOL_NAME \
    E2E_INCUS_PREFLIGHT_EGRESS_URL \
    E2E_INCUS_PREFLIGHT_SOURCE_SERVER \
    E2E_NODE_EXPORTER_URL \
    E2E_NODE_EXPORTER_TOKEN \
    E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT \
    E2E_NODE_EXPORTER_CA_FILE \
    E2E_NODE_EXPORTER_UNIT \
    E2E_ENABLE_OUTAGE_MUTATION \
    E2E_ENABLE_NETWORK_MUTATION \
    E2E_SHARED_BACKEND_ID \
    E2E_CEPHFS_FS_NAME \
    E2E_CEPHFS_FSID \
    E2E_CEPHFS_CLIENT_NAME \
    E2E_CEPHFS_CLUSTER_NAME \
    E2E_CEPHFS_MOUNT_PATH \
    E2E_CEPHFS_QUOTA_BYTES \
    E2E_CEPHFS_MON_HOSTS \
    E2E_CEPHFS_META_POOL \
    E2E_CEPHFS_DATA_POOL \
    E2E_CEPHFS_INCUS_POOL \
    E2E_CEPHFS_IDENTITY_KEY \
    E2E_CEPHFS_KEY \
    E2E_INCUS_KEY_ENCRYPTION_SECRET \
    E2E_SSH_PRIVATE_KEY_FILE \
    E2E_SSH_KNOWN_HOSTS \
    E2E_SSH_USER \
    E2E_GPU_PCI_PROOF \
    E2E_GPU_PCI_ADDRESS \
    E2E_GPU_PEER_HOST \
    E2E_GPU_PEER_SERVER_ID; do
    export "$name"
  done
}

record_phase() {
  local run_id="$1" phase="$2" status="$3" detail="${4:-}"
  local runtime_dir
  runtime_dir="$(runtime_dir_for "$run_id")"
  install -d -m 0700 "$runtime_dir"
  node "$E2E_ROOT/e2e/orchestrator/state.mjs" phase \
    "$runtime_dir" "$run_id" "$phase" "$status" "$detail"
}

wait_for_https() {
  local url="$1" attempts="${2:-90}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}
