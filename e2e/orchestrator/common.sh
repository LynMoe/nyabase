#!/usr/bin/env bash
set -euo pipefail

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_RUNTIME_BASE="$E2E_ROOT/e2e/.runtime"
E2E_COMPOSE_FILE="$E2E_ROOT/e2e/topology/docker-dind/compose.yaml"
HOST_NFSD_SNAPSHOT_CONTRACT="host-nfsd-systemd-v2"
mapfile -t E2E_STATE_KEYS < "$E2E_ROOT/e2e/orchestrator/run-state.keys"

log() {
  printf '[e2e] %s\n' "$*"
}

die() {
  printf '[e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

validate_run_id() {
  local value="$1"
  [[ "$value" =~ ^[a-z0-9][a-z0-9-]{2,47}$ ]] \
    || die "runId must match ^[a-z0-9][a-z0-9-]{2,47}$"
}

validate_profile() {
  case "$1" in
    smoke|core|full|recovery) ;;
    *) die "unknown CPU E2E profile: $1" ;;
  esac
}

resolve_run_id() {
  local supplied="${1:-${NYABASE_E2E_RUN_ID:-}}"
  if [[ -z "$supplied" ]]; then
    supplied="$(date -u +%Y%m%d%H%M%S)-$$-$(openssl rand -hex 3)"
  fi
  validate_run_id "$supplied"
  printf '%s\n' "$supplied"
}

require_run_id() {
  local supplied="${1:-${NYABASE_E2E_RUN_ID:-}}"
  [[ -n "$supplied" ]] \
    || die "an explicit runId argument or NYABASE_E2E_RUN_ID is required"
  validate_run_id "$supplied"
  printf '%s\n' "$supplied"
}

runtime_dir_for() {
  printf '%s/%s\n' "$E2E_RUNTIME_BASE" "$1"
}

# Every operational Full-chain state transition shares one advisory lock on
# the private runtime-base inode. This makes expected-predecessor comparison
# and candidate consumption one atomic operation across concurrent runners.
run_full_chain() {
  command -v flock >/dev/null 2>&1 || die "flock is required for Full-chain serialization"
  install -d -m 0700 "$E2E_RUNTIME_BASE"
  flock --exclusive "$E2E_RUNTIME_BASE" \
    node "$E2E_ROOT/e2e/orchestrator/full-run-chain.mjs" "$@"
}

subnet_overlaps_existing() {
  local subnet="$1"
  local -a existing=()
  mapfile -t existing < <(docker network ls -q | while read -r network_id; do
    [[ -n "$network_id" ]] || continue
    docker network inspect "$network_id" \
      --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' 2>/dev/null || true
  done | sed '/^$/d')
  node "$E2E_ROOT/e2e/orchestrator/cidr-overlap.mjs" "$subnet" "${existing[@]}"
}

slot_port_is_listening() {
  local port="$1"
  ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q .
}

publish_slot_owner() {
  local run_id="$1" lock_dir="$2"
  printf '%s\n' "$run_id" > "$lock_dir/run-id"
}

rollback_just_created_slot_lock() {
  local lock_dir="$1"
  [[ "$lock_dir" =~ ^/tmp/nyabase-e2e-slot-([0-9]|1[0-5])\.lock$ ]] || return 1
  rm -f "$lock_dir/run-id"
  rmdir "$lock_dir"
}

slot_port_is_available_for_run() {
  local port="$1" run_id="$2" expected_service="$3"
  if ! slot_port_is_listening "$port"; then
    return 0
  fi
  local -a publishers=()
  mapfile -t publishers < <(
    docker ps -q \
      --filter "label=io.nyabase.e2e.run-id=$run_id" \
      --filter "publish=$port"
  )
  ((${#publishers[@]} == 1)) || return 1
  [[ "$(docker inspect "${publishers[0]}" \
    --format '{{index .Config.Labels "com.docker.compose.service"}}')" == "$expected_service" ]]
}

stored_subnet_is_available_for_run() {
  local subnet="$1" run_id="$2" expected_network="$3"
  local network_id network_name network_owner existing_subnet
  while read -r network_id; do
    [[ -n "$network_id" ]] || continue
    while read -r existing_subnet; do
      [[ -n "$existing_subnet" ]] || continue
      if node "$E2E_ROOT/e2e/orchestrator/cidr-overlap.mjs" \
        "$subnet" "$existing_subnet"; then
        network_name="$(docker network inspect "$network_id" --format '{{.Name}}')"
        network_owner="$(docker network inspect "$network_id" \
          --format '{{index .Labels "io.nyabase.e2e.run-id"}}')"
        [[ "$network_name" == "$expected_network" && "$network_owner" == "$run_id" ]] \
          || return 1
      fi
    done < <(
      docker network inspect "$network_id" \
        --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' 2>/dev/null || true
    )
  done < <(docker network ls -q)
}

validate_stored_slot_state() {
  local run_id="$1" runtime_dir="$2"
  [[ "${NYABASE_E2E_RUN_ID:-}" == "$run_id" ]] || return 1
  [[ "${NYABASE_E2E_RUNTIME_DIR:-}" == "$runtime_dir" ]] || return 1
  [[ "${NYABASE_E2E_SLOT:-}" =~ ^([0-9]|1[0-5])$ ]] || return 1
  local slot="$NYABASE_E2E_SLOT"
  local third_octet=$((240 + slot))
  [[ "${NYABASE_E2E_SLOT_LOCK:-}" == "/tmp/nyabase-e2e-slot-${slot}.lock" ]] || return 1
  [[ "${NYABASE_E2E_SUBNET:-}" == "172.29.${third_octet}.0/24" ]] || return 1
  [[ "${NYABASE_E2E_NETWORK:-}" == "nyabase-e2e-${run_id}-cluster" ]] || return 1
  [[ "${NYABASE_E2E_EDGE_PORT:-}" == "$((18443 + slot))" ]] || return 1
  [[ "${NYABASE_E2E_RATE_LIMIT_EDGE_PORT:-}" == "$((19443 + slot))" ]] || return 1
}

load_e2e_state_file() {
  local state_file="$1" key value
  [[ -f "$state_file" && ! -L "$state_file" ]] || return 1
  [[ "$((8#$(stat -c '%a' "$state_file")))" -eq $((8#600)) ]] || return 1
  local -A allowed=() seen=()
  for key in "${E2E_STATE_KEYS[@]}"; do
    allowed["$key"]=1
    unset "$key"
  done
  while IFS='=' read -r key value; do
    [[ -n "$key" && "$key" =~ ^NYABASE_E2E_[A-Z0-9_]+$ && -v "allowed[$key]" ]] \
      || return 1
    [[ ! -v "seen[$key]" && "$value" != *$'\r'* ]] || return 1
    seen["$key"]=1
    printf -v "$key" '%s' "$value"
  done < "$state_file"
  for key in "${E2E_STATE_KEYS[@]}"; do
    [[ -v "seen[$key]" ]] || return 1
  done
}

validate_loaded_run_state() {
  local run_id="$1" runtime_dir="$2"
  validate_run_id "$run_id"
  validate_profile "${NYABASE_E2E_PROFILE:-}"
  validate_stored_slot_state "$run_id" "$runtime_dir" || return 1
  local slot="$NYABASE_E2E_SLOT"
  local third_octet=$((240 + slot))
  local prefix="nyabase-e2e-${run_id}"
  [[ "$NYABASE_E2E_ROOT" == "$E2E_ROOT" ]] || return 1
  [[ "$NYABASE_E2E_PREFIX" == "$prefix" ]] || return 1
  [[ "$NYABASE_E2E_PROJECT" == "$prefix" ]] || return 1
  [[ "$NYABASE_E2E_GATEWAY" == "172.29.${third_octet}.1" ]] || return 1
  [[ "$NYABASE_E2E_BACKEND_IP" == "172.29.${third_octet}.2" ]] || return 1
  [[ "$NYABASE_E2E_VM_IP" == "172.29.${third_octet}.3" ]] || return 1
  [[ "$NYABASE_E2E_EDGE_IP" == "172.29.${third_octet}.4" ]] || return 1
  [[ "$NYABASE_E2E_REGISTRY_IP" == "172.29.${third_octet}.5" ]] || return 1
  [[ "$NYABASE_E2E_SSH_PROXY_IP" == "172.29.${third_octet}.6" ]] || return 1
  [[ "$NYABASE_E2E_HTTP_PROXY_IP" == "172.29.${third_octet}.7" ]] || return 1
  [[ "$NYABASE_E2E_NFS_IP" == "172.29.${third_octet}.8" ]] || return 1
  [[ "$NYABASE_E2E_CEPH_IP" == "172.29.${third_octet}.9" ]] || return 1
  [[ "$NYABASE_E2E_STORAGE_CLIENT_IP" == "172.29.${third_octet}.10" ]] || return 1
  [[ "$NYABASE_E2E_NODE1_IP" == "172.29.${third_octet}.11" ]] || return 1
  [[ "$NYABASE_E2E_NODE2_IP" == "172.29.${third_octet}.12" ]] || return 1
  [[ "$NYABASE_E2E_RATE_LIMIT_EDGE_IP" == "172.29.${third_octet}.13" ]] || return 1
  [[ "$NYABASE_E2E_PROBE_IP" == "172.29.${third_octet}.20" ]] || return 1
  [[ "$NYABASE_E2E_PUBLIC_URL" == "https://localhost:$NYABASE_E2E_EDGE_PORT" ]] || return 1
  [[ "$NYABASE_E2E_RATE_LIMIT_PUBLIC_URL" == \
    "https://localhost:$NYABASE_E2E_RATE_LIMIT_EDGE_PORT" ]] || return 1
  [[ "$NYABASE_E2E_BACKEND_IMAGE" == "${prefix}-backend:worktree" ]] || return 1
  [[ "$NYABASE_E2E_NODE_IMAGE" == "${prefix}-node:worktree" ]] || return 1
  [[ "$NYABASE_E2E_SSH_PROXY_IMAGE" == "${prefix}-ssh-proxy:worktree" ]] || return 1
  [[ "$NYABASE_E2E_HTTP_PROXY_IMAGE" == "${prefix}-http-proxy:worktree" ]] || return 1
  [[ "$NYABASE_E2E_PROXY_TARGET_IMAGE" == "${prefix}-proxy-target:worktree" ]] || return 1
  [[ "$NYABASE_E2E_NFS_IMAGE" == "${prefix}-nfs-fixture:worktree" ]] || return 1
  [[ "$NYABASE_E2E_CEPH_IMAGE" == "${prefix}-ceph-fixture:worktree" ]] || return 1
  [[ "$NYABASE_E2E_STORAGE_CLIENT_IMAGE" == "${prefix}-storage-client:worktree" ]] || return 1
}

e2e_state_fingerprint() {
  local key
  for key in "${E2E_STATE_KEYS[@]}"; do
    printf '%s=%s\n' "$key" "${!key-}"
  done | sha256sum | awk '{print $1}'
}

validate_state_file_matches_loaded() {
  local state_file="$1" label="$2"
  local expected_run_id="$NYABASE_E2E_RUN_ID"
  local expected_runtime_dir="$NYABASE_E2E_RUNTIME_DIR"
  local expected_fingerprint
  expected_fingerprint="$(e2e_state_fingerprint)"
  (
    load_e2e_state_file "$state_file" \
      && validate_loaded_run_state "$expected_run_id" "$expected_runtime_dir" \
      && [[ "$(e2e_state_fingerprint)" == "$expected_fingerprint" ]]
  ) || die "$label does not match the validated E2E run state"
}

resume_stored_slot() {
  local run_id="$1" runtime_dir="$2"
  validate_stored_slot_state "$run_id" "$runtime_dir" \
    || die "stored E2E slot identity is invalid for runId $run_id"

  local reacquired=false owner
  if mkdir "$NYABASE_E2E_SLOT_LOCK" 2>/dev/null; then
    if ! publish_slot_owner "$run_id" "$NYABASE_E2E_SLOT_LOCK"; then
      rollback_just_created_slot_lock "$NYABASE_E2E_SLOT_LOCK" \
        || die "failed to roll back reacquired E2E slot ownership"
      die "failed to publish reacquired E2E slot ownership"
    fi
    reacquired=true
  else
    owner="$(tr -d '\n' < "$NYABASE_E2E_SLOT_LOCK/run-id" 2>/dev/null || true)"
    [[ "$owner" == "$run_id" ]] \
      || die "stored E2E slot lock is owned by another run"
  fi

  if ! stored_subnet_is_available_for_run \
      "$NYABASE_E2E_SUBNET" "$run_id" "$NYABASE_E2E_NETWORK" \
    || ! slot_port_is_available_for_run "$NYABASE_E2E_EDGE_PORT" "$run_id" edge \
    || ! slot_port_is_available_for_run \
      "$NYABASE_E2E_RATE_LIMIT_EDGE_PORT" "$run_id" rate-limit-edge; then
    if [[ "$reacquired" == true ]]; then
      release_slot_lock "$run_id" "$NYABASE_E2E_SLOT_LOCK" || true
    fi
    die "stored E2E slot collides with a foreign subnet or listener"
  fi
}

release_slot_lock() {
  local run_id="$1" lock_dir="$2"
  [[ "$lock_dir" =~ ^/tmp/nyabase-e2e-slot-([0-9]|1[0-5])\.lock$ ]] || return 1
  [[ -d "$lock_dir" ]] || return 0
  [[ "$(tr -d '\n' < "$lock_dir/run-id" 2>/dev/null || true)" == "$run_id" ]] || return 1
  rm -f "$lock_dir/run-id"
  rmdir "$lock_dir"
}

# Reserve subnet identity and both host listener ports as one authoritative
# slot decision. The directory lock serializes Nyabase allocators; checking
# the external Docker/network and listener state only after acquiring it keeps
# doctor/build on the same collision contract and releases rejected locks.
reserve_slot_for_run() {
  local run_id="$1"
  local slot lock_dir subnet third_octet edge_port rate_limit_edge_port
  RESERVED_SLOT=
  RESERVED_SLOT_LOCK=
  RESERVED_SUBNET=
  RESERVED_THIRD_OCTET=
  for slot in $(seq 0 15); do
    third_octet=$((240 + slot))
    subnet="172.29.${third_octet}.0/24"
    edge_port=$((18443 + slot))
    rate_limit_edge_port=$((19443 + slot))
    lock_dir="/tmp/nyabase-e2e-slot-${slot}.lock"
    if ! mkdir "$lock_dir" 2>/dev/null; then
      continue
    fi
    if ! publish_slot_owner "$run_id" "$lock_dir"; then
      rollback_just_created_slot_lock "$lock_dir" \
        || die "failed to roll back rejected E2E slot ownership"
      continue
    fi
    if subnet_overlaps_existing "$subnet" \
      || slot_port_is_listening "$edge_port" \
      || slot_port_is_listening "$rate_limit_edge_port"; then
      release_slot_lock "$run_id" "$lock_dir" \
        || die "failed to release rejected E2E slot lock: $lock_dir"
      continue
    fi
    RESERVED_SLOT="$slot"
    RESERVED_SLOT_LOCK="$lock_dir"
    RESERVED_SUBNET="$subnet"
    RESERVED_THIRD_OCTET="$third_octet"
    return 0
  done
  return 1
}

initialize_run() {
  local run_id="$1"
  local requested_profile="${NYABASE_E2E_PROFILE:-smoke}"
  validate_profile "$requested_profile"
  local runtime_dir
  runtime_dir="$(runtime_dir_for "$run_id")"
  install -d -m 0700 "$E2E_RUNTIME_BASE" "$runtime_dir"

  if [[ -s "$runtime_dir/state.env" ]]; then
    load_e2e_state_file "$runtime_dir/state.env" \
      || die "stored E2E state file is invalid for runId $run_id"
    [[ "$NYABASE_E2E_PROFILE" == "$requested_profile" ]] \
      || die "runId $run_id belongs to profile $NYABASE_E2E_PROFILE, not $requested_profile"
    validate_loaded_run_state "$run_id" "$runtime_dir" \
      || die "stored E2E state identity is invalid for runId $run_id"
    node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" assert-resumable \
      "$runtime_dir" "$run_id" \
      || die "runId $run_id is not a resumable E2E lifecycle; use a fresh runId"
    resume_stored_slot "$run_id" "$runtime_dir"
    export NYABASE_E2E_RUN_ID NYABASE_E2E_RUNTIME_DIR NYABASE_E2E_PREFIX \
      NYABASE_E2E_PROFILE
    return
  fi

  [[ ! -e "$runtime_dir/manifest.json" ]] \
    || die "runId $run_id has a manifest without usable state"

  reserve_slot_for_run "$run_id" \
    || die "no collision-free E2E slot (subnet plus both TLS ports) is available"
  local slot="$RESERVED_SLOT"
  local lock_dir="$RESERVED_SLOT_LOCK"
  local subnet="$RESERVED_SUBNET"
  local third_octet="$RESERVED_THIRD_OCTET"

  local prefix="nyabase-e2e-${run_id}"
  local edge_port=$((18443 + slot))
  local rate_limit_edge_port=$((19443 + slot))
  local state_tmp="$runtime_dir/.state.env.$$.tmp"
  if ! install -m 0600 /dev/null "$state_tmp"; then
    release_slot_lock "$run_id" "$lock_dir" || true
    die "failed to create E2E run state"
  fi
  if ! printf '%s\n' \
    "NYABASE_E2E_RUN_ID=$run_id" \
    "NYABASE_E2E_PROFILE=$requested_profile" \
    "NYABASE_E2E_ROOT=$E2E_ROOT" \
    "NYABASE_E2E_RUNTIME_DIR=$runtime_dir" \
    "NYABASE_E2E_PREFIX=$prefix" \
    "NYABASE_E2E_PROJECT=$prefix" \
    "NYABASE_E2E_NETWORK=${prefix}-cluster" \
    "NYABASE_E2E_SLOT=$slot" \
    "NYABASE_E2E_SLOT_LOCK=$lock_dir" \
    "NYABASE_E2E_SUBNET=$subnet" \
    "NYABASE_E2E_GATEWAY=172.29.${third_octet}.1" \
    "NYABASE_E2E_BACKEND_IP=172.29.${third_octet}.2" \
    "NYABASE_E2E_VM_IP=172.29.${third_octet}.3" \
    "NYABASE_E2E_EDGE_IP=172.29.${third_octet}.4" \
    "NYABASE_E2E_REGISTRY_IP=172.29.${third_octet}.5" \
    "NYABASE_E2E_SSH_PROXY_IP=172.29.${third_octet}.6" \
    "NYABASE_E2E_HTTP_PROXY_IP=172.29.${third_octet}.7" \
    "NYABASE_E2E_NFS_IP=172.29.${third_octet}.8" \
    "NYABASE_E2E_CEPH_IP=172.29.${third_octet}.9" \
    "NYABASE_E2E_STORAGE_CLIENT_IP=172.29.${third_octet}.10" \
    "NYABASE_E2E_NODE1_IP=172.29.${third_octet}.11" \
    "NYABASE_E2E_NODE2_IP=172.29.${third_octet}.12" \
    "NYABASE_E2E_RATE_LIMIT_EDGE_IP=172.29.${third_octet}.13" \
    "NYABASE_E2E_PROBE_IP=172.29.${third_octet}.20" \
    "NYABASE_E2E_EDGE_PORT=$edge_port" \
    "NYABASE_E2E_PUBLIC_URL=https://localhost:${edge_port}" \
    "NYABASE_E2E_RATE_LIMIT_EDGE_PORT=$rate_limit_edge_port" \
    "NYABASE_E2E_RATE_LIMIT_PUBLIC_URL=https://localhost:${rate_limit_edge_port}" \
    "NYABASE_E2E_BACKEND_IMAGE=${prefix}-backend:worktree" \
    "NYABASE_E2E_NODE_IMAGE=${prefix}-node:worktree" \
    "NYABASE_E2E_SSH_PROXY_IMAGE=${prefix}-ssh-proxy:worktree" \
    "NYABASE_E2E_HTTP_PROXY_IMAGE=${prefix}-http-proxy:worktree" \
    "NYABASE_E2E_PROXY_TARGET_IMAGE=${prefix}-proxy-target:worktree" \
    "NYABASE_E2E_NFS_IMAGE=${prefix}-nfs-fixture:worktree" \
    "NYABASE_E2E_CEPH_IMAGE=${prefix}-ceph-fixture:worktree" \
    "NYABASE_E2E_STORAGE_CLIENT_IMAGE=${prefix}-storage-client:worktree" > "$state_tmp" \
    || ! node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" init "$runtime_dir" "$run_id" \
    || ! mv -f "$state_tmp" "$runtime_dir/state.env"; then
    rm -f "$state_tmp" "$runtime_dir/state.env" "$runtime_dir/manifest.json"
    release_slot_lock "$run_id" "$lock_dir" || true
    die "failed to initialize E2E run state"
  fi

  load_e2e_state_file "$runtime_dir/state.env" \
    || die "new E2E state file is invalid for runId $run_id"
  validate_loaded_run_state "$run_id" "$runtime_dir" \
    || die "new E2E state identity is invalid for runId $run_id"
  export NYABASE_E2E_RUN_ID NYABASE_E2E_RUNTIME_DIR NYABASE_E2E_PREFIX \
    NYABASE_E2E_PROFILE
}

load_run() {
  local requested_run_id="$1"
  validate_run_id "$requested_run_id"
  local requested_runtime_dir
  requested_runtime_dir="$(runtime_dir_for "$requested_run_id")"
  [[ -s "$requested_runtime_dir/state.env" ]] || die "unknown runId: $requested_run_id"
  load_e2e_state_file "$requested_runtime_dir/state.env" \
    || die "stored E2E state file is invalid for runId $requested_run_id"
  validate_loaded_run_state "$requested_run_id" "$requested_runtime_dir" \
    || die "stored E2E state identity is invalid for runId $requested_run_id"
  export NYABASE_E2E_RUN_ID NYABASE_E2E_RUNTIME_DIR NYABASE_E2E_PREFIX \
    NYABASE_E2E_PROFILE
}

export_compose_state() {
  validate_loaded_run_state "$NYABASE_E2E_RUN_ID" "$NYABASE_E2E_RUNTIME_DIR" \
    || die "loaded E2E state identity is invalid before Compose export"
  validate_state_file_matches_loaded "$NYABASE_E2E_RUNTIME_DIR/state.env" "state.env"
  export "${E2E_STATE_KEYS[@]}"
}

validate_compose_state() {
  local compose_file="${1:-$NYABASE_E2E_RUNTIME_DIR/compose.env}"
  validate_state_file_matches_loaded "$compose_file" "compose.env"
}

docker_compose_for_run() {
  validate_compose_state
  local key
  local -a clean_environment=(env)
  local -a deadline=()
  if [[ -n "${NYABASE_E2E_COMMAND_TIMEOUT_SECONDS:-}" ]]; then
    [[ "$NYABASE_E2E_COMMAND_TIMEOUT_SECONDS" =~ ^[1-9][0-9]?$ ]] \
      || die "invalid E2E command timeout"
    deadline=(timeout --signal=TERM --kill-after=5s "${NYABASE_E2E_COMMAND_TIMEOUT_SECONDS}s")
  fi
  while IFS= read -r key; do
    clean_environment+=(-u "$key")
  done < <(env | sed -n 's/^\(COMPOSE_[A-Z0-9_]*\)=.*/\1/p' | LC_ALL=C sort -u)
  "${clean_environment[@]}" NYABASE_E2E_BACKEND_CLOCK_OFFSET_MS=0 \
    "${deadline[@]}" docker compose \
    --project-name "$NYABASE_E2E_PROJECT" \
    --env-file "$NYABASE_E2E_RUNTIME_DIR/compose.env" \
    -f "$E2E_COMPOSE_FILE" "$@"
}

manifest_phase() {
  node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" phase \
    "$NYABASE_E2E_RUNTIME_DIR" "$NYABASE_E2E_RUN_ID" "$1" "${2:-}"
}

manifest_resource() {
  node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" resource \
    "$NYABASE_E2E_RUNTIME_DIR" "$NYABASE_E2E_RUN_ID" "$1" "$2"
}

manifest_retire_resource() {
  node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" retire \
    "$NYABASE_E2E_RUNTIME_DIR" "$NYABASE_E2E_RUN_ID" "$1" "$2"
}

wait_for_https() {
  local url="$1" ca="$2" attempts="${3:-120}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --cacert "$ca" "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

snapshot_host_nfsd() {
  local output="$1"
  local unit state
  {
    printf '%s\n' '[mount]'
    findmnt -rn -t nfsd -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null \
      | awk '{$1=$1; print}' | LC_ALL=C sort || true
    printf '%s\n' '[services]'
    for unit in nfs-server.service nfsdcld.service; do
      printf '<%s>\n' "$unit"
      if state="$(LC_ALL=C systemctl show "$unit" --no-pager \
        --property=ActiveState \
        --property=SubState \
        --property=UnitFileState \
        --property=ActiveEnterTimestampMonotonic \
        --property=InvocationID 2>/dev/null)"; then
        printf '%s\n' "$state" | LC_ALL=C sort
      else
        printf '%s\n' unavailable
      fi
    done
    printf '%s\n' '[listener]'
    ss -H -lntu 'sport = :2049' 2>/dev/null \
      | awk '{print $1, $2, $5, $6}' | LC_ALL=C sort || true
    printf '%s\n' '[versions]'
    [[ ! -r /proc/fs/nfsd/versions ]] || cat /proc/fs/nfsd/versions
    printf '%s\n' '[threads]'
    [[ ! -r /proc/fs/nfsd/threads ]] || cat /proc/fs/nfsd/threads
  } > "$output"
  chmod 0600 "$output"
}
