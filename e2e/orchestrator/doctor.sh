#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

HOST_FORWARD_USER_CHAIN="$(printf '%s%s' 'DOCK' 'ER-USER')"

run_id="${1:-${E2E_RUN_ID:-}}"
profile="${E2E_PROFILE:-smoke}"
if [[ -n "$run_id" ]]; then
  validate_run_id "$run_id"
fi
validate_profile "$profile"

capabilities=()
blocked=()
evidence=()

pass() {
  local capability="$1" detail="$2"
  capabilities+=("$capability")
  evidence+=("PASS $capability :: $detail")
}

block() {
  local detail="$1"
  blocked+=("$detail")
  evidence+=("BLOCKED :: $detail")
}

if [[ -n "$run_id" ]]; then
  # Load optional CephFS fixture from the run runtime (secrets stay untracked).
  maybe_source_cephfs_fixture "$(runtime_dir_for "$run_id")"
fi

if [[ "${E2E_GPU_PCI_PROOF:-}" == "1" && -n "${E2E_GPU_PCI_ADDRESS:-}" ]]; then
  pass gpu-pci "peer/hardware GPU PCI proof for ${E2E_GPU_PCI_ADDRESS}"
else
  evidence+=(
    "BLOCKED capability :: gpu-pci :: no GPU PCI hardware is claimed by this standalone host"
  )
fi

if [[ -n "${E2E_SHARED_BACKEND_ID:-}" \
  && -n "${E2E_CEPHFS_FSID:-}" \
  && -n "${E2E_CEPHFS_IDENTITY_KEY:-}" \
  && -n "${E2E_CEPHFS_INCUS_POOL:-}" ]]; then
  pass cephfs-cluster \
    "shared backend ${E2E_SHARED_BACKEND_ID} identity ${E2E_CEPHFS_IDENTITY_KEY} pool ${E2E_CEPHFS_INCUS_POOL}"
else
  evidence+=(
    "BLOCKED capability :: cephfs-cluster :: no multi-node CephFS cluster is provisioned"
  )
fi

need_command() {
  local command="$1"
  if command -v "$command" >/dev/null 2>&1; then
    evidence+=("PASS command :: $command")
  else
    block "missing command $command"
  fi
}

need_env() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    evidence+=("PASS input :: $name")
  else
    block "missing runtime input $name"
  fi
}

for command in incus pg_isready psql curl openssl node pnpm rg ip sysctl nft ssh; do
  need_command "$command"
done
if [[ "$profile" == "full" || "$profile" == "recovery" ]]; then
  need_command systemctl
fi

if [[ "$profile" == "core" || "$profile" == "full" || "$profile" == "recovery" ]]; then
  [[ "${E2E_ENABLE_NETWORK_MUTATION:-}" == "1" ]] \
    && evidence+=("PASS input :: E2E_ENABLE_NETWORK_MUTATION") \
    || block "set E2E_ENABLE_NETWORK_MUTATION=1 to authorize the routed spoof probe"
fi

for name in \
  NYABASE_CONFIG_FILE \
  E2E_BASE_URL \
  E2E_ADMIN_USERNAME \
  E2E_ADMIN_PASSWORD \
  E2E_DATABASE_URL \
  E2E_INCUS_API_ENDPOINT \
  E2E_INCUS_SERVER_CERT_FINGERPRINT \
  E2E_INCUS_CLIENT_CERT \
  E2E_INCUS_CLIENT_KEY \
  E2E_INCUS_CA_FILE \
  E2E_EDGE_CA_FILE \
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
  E2E_SSH_PRIVATE_KEY_FILE \
  E2E_SSH_KNOWN_HOSTS \
  E2E_SSH_USER; do
  need_env "$name"
done

for name in \
  NYABASE_CONFIG_FILE \
  E2E_EDGE_CA_FILE \
  E2E_INCUS_CLIENT_CERT \
  E2E_INCUS_CLIENT_KEY \
  E2E_INCUS_CA_FILE \
  E2E_SSH_PRIVATE_KEY_FILE \
  E2E_SSH_KNOWN_HOSTS; do
  if [[ -f "${!name:-}" && ! -L "${!name:-}" && -r "${!name:-}" ]]; then
    evidence+=("PASS file :: $name")
  else
    block "$name is not a readable regular file"
  fi
done
if [[ -n "${E2E_NODE_EXPORTER_CA_FILE:-}" ]]; then
  if [[ -f "$E2E_NODE_EXPORTER_CA_FILE" && ! -L "$E2E_NODE_EXPORTER_CA_FILE" \
    && -r "$E2E_NODE_EXPORTER_CA_FILE" ]]; then
    evidence+=("PASS file :: E2E_NODE_EXPORTER_CA_FILE")
  else
    block "E2E_NODE_EXPORTER_CA_FILE is not a readable regular file"
  fi
fi

if [[ "${E2E_INCUS_SERVER_CERT_FINGERPRINT:-}" =~ ^[0-9A-Fa-f:]{32,95}$ ]]; then
  evidence+=("PASS input :: E2E_INCUS_SERVER_CERT_FINGERPRINT shape")
else
  block "E2E_INCUS_SERVER_CERT_FINGERPRINT is malformed"
fi
if [[ "${E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT:-}" =~ ^[0-9A-Fa-f:]{32,95}$ ]]; then
  evidence+=("PASS input :: E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT shape")
else
  block "E2E_NODE_EXPORTER_SERVER_CERT_FINGERPRINT is malformed"
fi
if [[ "${E2E_INCUS_IMAGE_FINGERPRINT:-}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  evidence+=("PASS input :: E2E_INCUS_IMAGE_FINGERPRINT shape")
else
  block "E2E_INCUS_IMAGE_FINGERPRINT must be 64 hexadecimal characters"
fi
if [[ "${E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT:-}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  evidence+=("PASS input :: E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT shape")
else
  block "E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT must be 64 hexadecimal characters"
fi

if pg_isready -d "${E2E_DATABASE_URL:-invalid}" >/dev/null 2>&1; then
  pass postgresql "pg_isready accepted E2E_DATABASE_URL"
else
  block "PostgreSQL is not ready for E2E_DATABASE_URL"
fi

incus_version="$(incus version 2>/dev/null || true)"
if [[ -n "$incus_version" ]]; then
  pass incus-https-mtls "Incus CLI is connected"
else
  block "Incus CLI cannot reach the local daemon"
fi

if [[ -f "${E2E_EDGE_CA_FILE:-}" && ! -L "$E2E_EDGE_CA_FILE" ]]; then
  pass certificate-rotation "edge CA is available for certificate rotation evidence"
else
  block "E2E_EDGE_CA_FILE is not a readable CA file"
fi

dir_pool="${E2E_INCUS_DIR_POOL:-}"
lvm_pool="${E2E_INCUS_LVM_POOL:-}"
dir_info="$(incus storage show "$dir_pool" 2>/dev/null || true)"
lvm_info="$(incus storage show "$lvm_pool" 2>/dev/null || true)"
if [[ -n "$dir_info" ]] && rg -qi 'driver:\s*dir' <<<"$dir_info" \
  && [[ "${E2E_INCUS_DIR_QUOTA_PROOF:-}" == "1" ]]; then
  pass storage-dir-quota-online "dir pool and quota proof are present"
else
  block "dir pool is absent, not dir-backed, or E2E_INCUS_DIR_QUOTA_PROOF=1 is missing"
fi
if [[ -n "$lvm_info" ]] && rg -qi 'driver:\s*lvm' <<<"$lvm_info" \
  && [[ "${E2E_INCUS_LVM_BLOCK_PROOF:-}" == "1" ]]; then
  lvm_ready=true
  if [[ -n "$run_id" ]]; then
    if ! bash "$SCRIPT_DIR/provision-incus.sh" ensure-lvm "$run_id" >/dev/null; then
      lvm_ready=false
      block "LVM activation-skip workaround failed for pool $lvm_pool"
    else
      lvm_proof="$(runtime_dir_for "$run_id")/lvm-activation-skip-proof"
      if [[ -f "$lvm_proof" && ! -L "$lvm_proof" ]] \
        && rg -Fq 'state=ready' "$lvm_proof"; then
        evidence+=("INFO lvm-activation-skip :: $(tr '\n' ' ' <"$lvm_proof" | sed 's/[[:space:]]*$//')")
      else
        lvm_ready=false
        block "LVM activation-skip proof is missing after ensure-lvm"
      fi
    fi
  fi
  if [[ "$lvm_ready" == true ]]; then
    pass storage-lvm-block-backed "lvm pool, block-backed proof, and activation-skip bring-up are present"
  fi
else
  block "lvm pool is absent, not LVM-backed, or E2E_INCUS_LVM_BLOCK_PROOF=1 is missing"
fi

parent="${E2E_INCUS_PARENT_INTERFACE:-}"
filter_value="$(sysctl -n "net.ipv4.conf.${parent}.rp_filter" 2>/dev/null || true)"
if ip link show "$parent" >/dev/null 2>&1; then
  parent_addresses="$(ip -o -4 addr show dev "$parent" 2>/dev/null | awk '{print $4}' | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  parent_routes="$(ip -4 route show dev "$parent" 2>/dev/null | tr '\n' ';' | sed 's/;$//')"
  gateway_route="$(ip -4 route get "${E2E_INCUS_ROUTED_GATEWAY:-0.0.0.0}" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  evidence+=("INFO host-lan :: interface=$parent addresses=$parent_addresses routes=$parent_routes gateway_route=$gateway_route")
  evidence+=("INFO macvlan-mode :: parent=$parent subnet=${E2E_INCUS_ROUTED_SUBNET:-} (host↔local-container isolation accepted)")
  if [[ -n "$parent_addresses" ]]; then
    pass macvlan-parent "macvlan parent interface $parent exists with IPv4 addresses $parent_addresses"
  else
    block "macvlan parent $parent has no IPv4 address"
  fi
  if [[ "$filter_value" == "1" || "$filter_value" == "2" ]]; then
    pass rp-filter "parent rp_filter=$filter_value is enabled (>=1)"
  else
    evidence+=("INFO rp-filter-policy :: parent=$parent rp_filter=${filter_value:-unset}")
    pass rp-filter "parent rp_filter=${filter_value:-unset} observed for macvlan (not enforced for LAN L2)"
  fi
else
  block "macvlan parent missing: '${parent:-unset}'"
fi

# macvlan containers egress via the LAN gateway; host forward/NAT tables are unused.

if [[ -n "$run_id" ]]; then
  ownership="$(runtime_dir_for "$run_id")/network-ownership"
  if [[ -f "$ownership" ]] \
    && rg -Fq "parent_interface=$parent" "$ownership" \
    && rg -Fq "routed_subnet=${E2E_INCUS_ROUTED_SUBNET:-}" "$ownership" \
    && rg -Fq 'mode=macvlan' "$ownership"; then
    evidence+=("INFO network-ownership :: $(tr '\n' ' ' <"$ownership")")
  else
    block "run-owned macvlan network ownership metadata is missing or mismatched"
  fi
else
  block "an explicit run id is required to validate macvlan network ownership"
fi

source_url="${E2E_INCUS_IMAGE_SOURCE_URL:-}"
remote_name="${E2E_INCUS_IMAGE_REMOTE:-}"
remote_url="$(
  incus remote list --format csv 2>/dev/null \
    | awk -F, -v remote="$remote_name" '$1 == remote { print $2; exit }'
)"
if [[ "$source_url" == https://* && "$remote_url" == https://* ]] \
  && curl --fail --silent --show-error --max-time 10 \
    "${source_url%/}/streams/v1/index.json" >/dev/null 2>&1; then
  pass private-simplestreams "private HTTPS simplestreams index is reachable"
else
  block "private HTTPS simplestreams index is not reachable"
fi

image_info="$(
  incus image info \
    "${E2E_INCUS_IMAGE_REMOTE:-}:${E2E_INCUS_IMAGE_ALIAS:-}" 2>/dev/null || true
)"
if [[ "${E2E_INCUS_IMAGE_NO_DHCP:-}" == "1" ]] \
  && [[ "$remote_url" == https://* ]] \
  && rg -qi 'sshd[-_.]no[-_.]dhcp\s*[:=]\s*(true|1)' <<<"$image_info" \
  && rg -Fqi "${E2E_INCUS_IMAGE_FINGERPRINT:-}" <<<"$image_info"; then
  pass sshd-no-dhcp-image "Incus image metadata proves SSHD without DHCP"
else
  block "private image metadata must prove SSHD without DHCP and the pinned fingerprint"
fi

preflight_image_info="$(
  incus image info \
    "${E2E_INCUS_IMAGE_REMOTE:-}:${E2E_INCUS_PREFLIGHT_IMAGE_ALIAS:-}" 2>/dev/null || true
)"
if [[ "$remote_url" == https://* ]] \
  && rg -Fqi "${E2E_INCUS_PREFLIGHT_IMAGE_FINGERPRINT:-}" <<<"$preflight_image_info"; then
  pass preflight-image "preflight alias resolves to the pinned immutable fingerprint"
else
  block "preflight image alias does not resolve to the pinned immutable fingerprint"
fi

if [[ "${E2E_INCUS_PREFLIGHT_EGRESS_URL:-}" == https://* ]]; then
  pass preflight-egress "preflight egress target is a fixed HTTPS runtime input"
else
  block "preflight egress target must be a fixed HTTPS runtime input"
fi

metrics_curl_args=(--fail --silent --show-error --max-time 10)
if [[ -n "${E2E_NODE_EXPORTER_CA_FILE:-}" ]]; then
  metrics_curl_args+=(--cacert "$E2E_NODE_EXPORTER_CA_FILE")
fi
if [[ -n "${E2E_NODE_EXPORTER_URL:-}" && -n "${E2E_NODE_EXPORTER_TOKEN:-}" ]] \
  && curl "${metrics_curl_args[@]}" \
    -H "Authorization: Bearer ${E2E_NODE_EXPORTER_TOKEN}" \
    "$E2E_NODE_EXPORTER_URL" >/dev/null 2>&1; then
  pass node-exporter-authenticated-pull "authenticated exporter pull succeeded"
else
  block "authenticated node-exporter pull is not configured or reachable"
fi

if [[ "$profile" == "full" || "$profile" == "recovery" ]]; then
  for name in E2E_NODE_EXPORTER_UNIT; do
    need_env "$name"
  done
  [[ "${E2E_ENABLE_OUTAGE_MUTATION:-}" == "1" ]] \
    && evidence+=("PASS input :: E2E_ENABLE_OUTAGE_MUTATION") \
    || block "set E2E_ENABLE_OUTAGE_MUTATION=1 to authorize exporter stop/restore"
  if systemctl cat "${E2E_NODE_EXPORTER_UNIT:-}" >/dev/null 2>&1 \
    && systemctl is-active --quiet "${E2E_NODE_EXPORTER_UNIT:-}"; then
    pass node-exporter-unit "node-exporter unit is active before outage mutation"
  else
    block "node-exporter unit is not installed and active"
  fi
else
  evidence+=("INFO node-exporter-outage :: required by full and recovery profiles")
fi

if [[ -n "${E2E_INCUS_API_ENDPOINT:-}" && -f "${E2E_INCUS_CA_FILE:-}" \
  && -f "${E2E_INCUS_CLIENT_CERT:-}" && -f "${E2E_INCUS_CLIENT_KEY:-}" ]]; then
  if curl --fail --silent --show-error --max-time 10 \
    --cacert "$E2E_INCUS_CA_FILE" \
    --cert "$E2E_INCUS_CLIENT_CERT" \
    --key "$E2E_INCUS_CLIENT_KEY" \
    "${E2E_INCUS_API_ENDPOINT%/}/1.0" >/dev/null 2>&1; then
    pass trust-token-onboarding "Incus HTTPS endpoint accepts the configured mTLS identity"
  else
    block "Incus HTTPS endpoint rejected the configured mTLS identity"
  fi
else
  block "Incus CA, client certificate, client key, and endpoint are required"
fi

if [[ -n "$run_id" ]]; then
  runtime_dir="$(runtime_dir_for "$run_id")"
  install -d -m 0700 "$runtime_dir"
  printf '%s\n' "${evidence[@]}" > "$runtime_dir/doctor.evidence"
  chmod 0600 "$runtime_dir/doctor.evidence"
fi

if ((${#blocked[@]} > 0)); then
  printf '[e2e] doctor BLOCKED (%s):\n' "$profile" >&2
  printf '  - %s\n' "${blocked[@]}" >&2
  [[ -z "$run_id" ]] || record_phase "$run_id" doctor blocked "${blocked[*]}"
  exit 2
fi

capability_csv="$(IFS=,; printf '%s' "${capabilities[*]}")"
printf 'E2E_CAPABILITIES=%s\n' "$capability_csv"
printf '[e2e] doctor passed with %s capabilities\n' "${#capabilities[@]}"
[[ -z "$run_id" ]] || record_phase "$run_id" doctor passed "$capability_csv"
