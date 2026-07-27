#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
keep_runtime=false
[[ "${2:-}" == --keep-runtime ]] && keep_runtime=true

runtime_dir="$(runtime_dir_for "$run_id")"
prefix="nyabase-e2e-${run_id}"
diagnostics_dir="$runtime_dir/diagnostics"
cleanup_diagnostics="$diagnostics_dir/cleanup.log"
install -d -m 0700 "$diagnostics_dir"
: > "$cleanup_diagnostics"
chmod 0600 "$cleanup_diagnostics"
if [[ -s "$runtime_dir/state.env" ]]; then
  load_run "$run_id"
  export_compose_state
  if [[ -s "$runtime_dir/compose.env" ]]; then
    validate_compose_state "$runtime_dir/compose.env"
  fi
else
  [[ ! -e "$runtime_dir/compose.env" ]] \
    || die "cannot trust compose.env without validated run state"
  NYABASE_E2E_RUNTIME_DIR="$runtime_dir"
  NYABASE_E2E_PREFIX="$prefix"
fi

cleanup_failures=()

run_cleanup_step() {
  local label="$1"
  shift
  [[ "$label" =~ ^[a-zA-Z0-9._-]+$ ]] || die "invalid cleanup diagnostic label"
  local step_log="$diagnostics_dir/.${label}.log"
  : > "$step_log"
  chmod 0600 "$step_log"
  if "$@" >"$step_log" 2>&1; then
    rm -f "$step_log"
    return 0
  fi
  cleanup_failures+=("$label")
  {
    printf '[%s]\n' "$label"
    tail -c 65536 "$step_log" \
      | node "$E2E_ROOT/e2e/orchestrator/sanitize-diagnostic.mjs"
  } >> "$cleanup_diagnostics"
  rm -f "$step_log"
  if [[ "$(stat -c '%s' "$cleanup_diagnostics")" -gt 262144 ]]; then
    local bounded_log="$diagnostics_dir/.cleanup.bounded"
    tail -c 262144 "$cleanup_diagnostics" > "$bounded_log"
    chmod 0600 "$bounded_log"
    mv -f "$bounded_log" "$cleanup_diagnostics"
  fi
  return 1
}

if [[ -s "$runtime_dir/proxies/client-runtime/ssh-hold.json" ]] \
  && [[ -s "$runtime_dir/state.env" ]]; then
  if ! printf '%s\n' "{\"runId\":\"$run_id\",\"action\":\"sshHoldRelease\"}" \
    | node "$E2E_ROOT/e2e/orchestrator/proxy-client-control.mjs" "$runtime_dir" \
      >/dev/null 2>&1; then
    cleanup_failures+=(ssh-proxy-client-release)
  fi
fi

# A Full storage-failure case may be interrupted while the run-owned NFS
# fixture is stopped. Restore only that exact labelled container before node
# cleanup so hard NFS mounts can be released normally.
if [[ "${NYABASE_E2E_PROFILE:-}" == full ]]; then
  nfs_fixture="$prefix-nfs-fixture"
  if docker inspect "$nfs_fixture" >/dev/null 2>&1 \
    && [[ "$(docker inspect "$nfs_fixture" --format '{{index .Config.Labels "io.nyabase.e2e.run-id"}}')" == "$run_id" ]] \
    && [[ "$(docker inspect "$nfs_fixture" --format '{{.State.Running}}')" != true ]]; then
    if ! docker start "$nfs_fixture" >/dev/null 2>&1; then
      cleanup_failures+=(nfs-fixture-restore)
    else
      sleep 1
    fi
  fi
fi

# A killed SSH evidence subprocess can leave its one-shot client alive until
# the inner timeout fires. Remove the exact run-labelled client first so its
# private /run tmpfs (including any 0600 key file) is destroyed even on an
# interrupted test. The generic run-label sweep below remains a second fence.
mapfile -t ssh_probe_containers < <(
  docker ps -aq \
    --filter "label=io.nyabase.e2e.run-id=$run_id" \
    --filter 'label=io.nyabase.e2e.component=provider-container-ssh-client'
)
for container_id in "${ssh_probe_containers[@]}"; do
  [[ -n "$container_id" ]] || continue
  docker rm -f "$container_id" >/dev/null 2>&1 || true
done

for node_key in node1 node2; do
  name="$prefix-$node_key"
  if docker inspect "$name" >/dev/null 2>&1; then
    run_cleanup_step "${node_key}-physical-cleanup" \
      docker exec "$name" /usr/local/libexec/nyabase-e2e/cleanup-node || true
  fi
done

# A provider fault may provision a real third systemd/XFS node. Clean its
# recorded loop device and mounts before label-based container removal, even
# when a Playwright process died before its finally block ran.
mapfile -t provider_fault_nodes < <(
  docker ps -a \
    --filter "label=io.nyabase.e2e.run-id=$run_id" \
    --filter 'label=io.nyabase.e2e.component=provider-fault-node' \
    --format '{{.Names}}'
)
for name in "${provider_fault_nodes[@]}"; do
  [[ -n "$name" ]] || continue
  if ! docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null | grep -qx true; then
    # `docker run` can leave a labelled object in `created` state when OCI
    # start fails before PID 1 exists. Such a node cannot own mounts or loop
    # devices, so removing it directly is the correct crash-recovery cleanup.
    if [[ "$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)" == created ]]; then
      docker rm -f "$name" >/dev/null 2>&1 \
        || cleanup_failures+=("${name}-unstarted-remove")
      continue
    fi
    docker start "$name" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      state="$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)"
      [[ "$state" == running || "$state" == degraded ]] && break
      sleep 1
    done
  fi
  run_cleanup_step "${name}-physical-cleanup" \
    docker exec "$name" /usr/local/libexec/nyabase-e2e/cleanup-node || true
done

if [[ -d "$runtime_dir/storage" ]]; then
  storage_dir="$runtime_dir/storage"
  readiness_client="$prefix-storage-readiness"
  ceph_fixture="$prefix-cephfs-fixture"
  nfs_fixture="$prefix-nfs-fixture"
  if docker inspect "$readiness_client" >/dev/null 2>&1; then
    if [[ "$(docker inspect "$readiness_client" --format '{{.State.Running}}')" == true ]]; then
      for target in /mnt/ceph /mnt/nfs; do
        if docker exec "$readiness_client" mountpoint -q "$target" >/dev/null 2>&1; then
          timeout 60 docker exec "$readiness_client" umount "$target" >/dev/null 2>&1 \
            || cleanup_failures+=("storage-readiness-unmount-${target##*/}")
        fi
      done
    fi
    docker rm -f "$readiness_client" >/dev/null 2>&1 \
      || cleanup_failures+=(storage-readiness-remove)
  fi

  if docker inspect "$ceph_fixture" >/dev/null 2>&1; then
    if [[ "$(docker inspect "$ceph_fixture" --format '{{.State.Running}}')" == true ]]; then
      docker stop --time 30 "$ceph_fixture" >/dev/null 2>&1 \
        || cleanup_failures+=(cephfs-fixture-stop)
    fi
    docker rm -f "$ceph_fixture" >/dev/null 2>&1 \
      || cleanup_failures+=(cephfs-fixture-remove)
  fi
  if docker inspect "$nfs_fixture" >/dev/null 2>&1; then
    if [[ "$(docker inspect "$nfs_fixture" --format '{{.State.Running}}')" == true ]]; then
      docker stop --time 10 "$nfs_fixture" >/dev/null 2>&1 \
        || cleanup_failures+=(nfs-fixture-stop)
    fi
    docker rm -f "$nfs_fixture" >/dev/null 2>&1 \
      || cleanup_failures+=(nfs-fixture-remove)
  fi

  loop_detached=true
  if [[ -s "$storage_dir/ceph-loop-device" ]]; then
    loop_device="$(tr -d '\n' < "$storage_dir/ceph-loop-device")"
    backing_file="$storage_dir/ceph-osd.raw"
    if [[ ! "$loop_device" =~ ^/dev/loop[0-9]+$ ]]; then
      cleanup_failures+=(cephfs-loop-identity)
      loop_detached=false
    elif losetup "$loop_device" >/dev/null 2>&1; then
      observed_backing="$(losetup -n -O BACK-FILE "$loop_device" 2>/dev/null || true)"
      if [[ -z "$observed_backing" ]] \
        || [[ "$(readlink -f "$observed_backing")" != "$(readlink -f "$backing_file")" ]]; then
        cleanup_failures+=(cephfs-loop-ownership)
        loop_detached=false
      elif ! losetup --detach "$loop_device"; then
        cleanup_failures+=(cephfs-loop-detach)
        loop_detached=false
      fi
    fi
  fi

  nfsd_unchanged=false
  nfsd_before_sha256=""
  nfsd_after_sha256=""
  if [[ -s "$storage_dir/nfsd.before" ]]; then
    snapshot_host_nfsd "$storage_dir/nfsd.after"
    nfsd_before_sha256="$(sha256sum "$storage_dir/nfsd.before" | awk '{print $1}')"
    nfsd_after_sha256="$(sha256sum "$storage_dir/nfsd.after" | awk '{print $1}')"
    if cmp -s "$storage_dir/nfsd.before" "$storage_dir/nfsd.after"; then
      nfsd_unchanged=true
    else
      cleanup_failures+=(host-nfsd-changed)
    fi
  else
    cleanup_failures+=(host-nfsd-baseline-missing)
  fi

  node --input-type=module - \
    "$runtime_dir/storage-cleanup-evidence.json" "$run_id" "$loop_detached" \
    "$nfsd_unchanged" "$nfsd_before_sha256" "$nfsd_after_sha256" \
    "$HOST_NFSD_SNAPSHOT_CONTRACT" <<'NODE'
import { writeFileSync } from 'node:fs';
const [
  path, runId, loopDetached, hostNfsdUnchanged, before, after, hostNfsdSnapshotContract,
] = process.argv.slice(2);
writeFileSync(path, `${JSON.stringify({
  schemaVersion: 1,
  runId,
  exactLoopDetached: loopDetached === 'true',
  hostNfsdUnchanged: hostNfsdUnchanged === 'true',
  hostNfsdSnapshotContract,
  hostNfsdBeforeSha256: before,
  hostNfsdAfterSha256: after,
  observedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });
NODE
  if [[ "$nfsd_unchanged" != true ]]; then
    [[ ! -s "$storage_dir/nfsd.before" ]] \
      || install -m 0600 "$storage_dir/nfsd.before" "$runtime_dir/host-nfsd-before.txt"
    [[ ! -s "$storage_dir/nfsd.after" ]] \
      || install -m 0600 "$storage_dir/nfsd.after" "$runtime_dir/host-nfsd-after.txt"
  fi
  if [[ "$loop_detached" == true ]]; then
    rm -rf "$storage_dir"
  fi
fi

label="io.nyabase.e2e.run-id=$run_id"
{
  docker ps -aq --filter "label=$label"
  docker ps -a --format '{{.ID}} {{.Names}}' \
    | awk -v prefix="$prefix-" '$2 ~ "^" prefix { print $1 }'
} | sort -u | while read -r container_id; do
  [[ -n "$container_id" ]] && docker rm -f "$container_id" >/dev/null 2>&1 || true
done

if [[ -s "$runtime_dir/compose.env" ]]; then
  docker_compose_for_run down --volumes --remove-orphans >/dev/null 2>&1 || true
fi

docker network ls -q --filter "label=$label" | while read -r network_id; do
  [[ -n "$network_id" ]] && docker network rm "$network_id" >/dev/null 2>&1 || true
done
docker network ls --format '{{.ID}} {{.Name}}' \
  | awk -v prefix="$prefix-" '$2 ~ "^" prefix { print $1 }' \
  | while read -r network_id; do
      [[ -n "$network_id" ]] && docker network rm "$network_id" >/dev/null 2>&1 || true
    done
docker volume ls -q --filter "label=$label" | while read -r volume_name; do
  [[ -n "$volume_name" ]] && docker volume rm -f "$volume_name" >/dev/null 2>&1 || true
done
docker volume ls --format '{{.Name}}' \
  | awk -v prefix="$prefix-" 'index($0, prefix) == 1 { print }' \
  | while read -r volume_name; do
      [[ -n "$volume_name" ]] && docker volume rm -f "$volume_name" >/dev/null 2>&1 || true
    done
docker image ls -q --filter "label=$label" | sort -u | while read -r image_id; do
  [[ -n "$image_id" ]] && docker image rm -f "$image_id" >/dev/null 2>&1 || true
done
docker image ls --format '{{.Repository}} {{.ID}}' \
  | awk -v prefix="$prefix-" 'index($1, prefix) == 1 { print $2 }' \
  | sort -u | while read -r image_id; do
      [[ -n "$image_id" ]] && docker image rm -f "$image_id" >/dev/null 2>&1 || true
    done

leaks=("${cleanup_failures[@]}")
[[ -z "$(docker ps -aq --filter "label=$label")" ]] || leaks+=(containers)
[[ -z "$(docker network ls -q --filter "label=$label")" ]] || leaks+=(networks)
[[ -z "$(docker volume ls -q --filter "label=$label")" ]] || leaks+=(volumes)
[[ -z "$(docker image ls -q --filter "label=$label")" ]] || leaks+=(images)
[[ -z "$(docker ps -a --format '{{.Names}}' | awk -v prefix="$prefix-" 'index($0, prefix) == 1')" ]] \
  || leaks+=(prefix-containers)
[[ -z "$(docker network ls --format '{{.Name}}' | awk -v prefix="$prefix-" 'index($0, prefix) == 1')" ]] \
  || leaks+=(prefix-networks)
[[ -z "$(docker volume ls --format '{{.Name}}' | awk -v prefix="$prefix-" 'index($0, prefix) == 1')" ]] \
  || leaks+=(prefix-volumes)
[[ -z "$(docker image ls --format '{{.Repository}}' | awk -v prefix="$prefix-" 'index($0, prefix) == 1')" ]] \
  || leaks+=(prefix-images)
losetup -a | grep -Fq "$run_id" && leaks+=(loop-devices)
findmnt -rn -o TARGET,SOURCE | grep -Fq "$run_id" && leaks+=(mounts)
pgrep -fa "$prefix" >/dev/null 2>&1 && leaks+=(processes)

if [[ -n "${NYABASE_E2E_EDGE_PORT:-}" ]]; then
  ss -H -ltn | awk '{print $4}' | grep -Eq "[:.]${NYABASE_E2E_EDGE_PORT}$" \
    && leaks+=(edge-port)
fi
if [[ -n "${NYABASE_E2E_RATE_LIMIT_EDGE_PORT:-}" ]]; then
  ss -H -ltn | awk '{print $4}' | grep -Eq "[:.]${NYABASE_E2E_RATE_LIMIT_EDGE_PORT}$" \
    && leaks+=(rate-limit-edge-port)
fi
if [[ -n "${NYABASE_E2E_SPLIT_GATEWAY_EDGE_PORT:-}" ]]; then
  ss -H -ltn | awk '{print $4}' | grep -Eq "[:.]${NYABASE_E2E_SPLIT_GATEWAY_EDGE_PORT}$" \
    && leaks+=(split-gateway-edge-port)
fi

# Secrets are never retained as diagnostics, including when --keep-runtime is
# used by the one-shot runner after a failed test or cleanup.
rm -f "$runtime_dir/secrets.env" "$runtime_dir/backend.yaml"
rm -rf "$runtime_dir/backend-config" "$runtime_dir/certs" "$runtime_dir/agents" \
  "$runtime_dir/proxies"
[[ ! -e "$runtime_dir/secrets.env" ]] || leaks+=(secret-env)
[[ ! -e "$runtime_dir/backend.yaml" ]] || leaks+=(legacy-backend-config)
[[ ! -e "$runtime_dir/backend-config" ]] || leaks+=(backend-config)
[[ ! -e "$runtime_dir/certs" ]] || leaks+=(certificates)
[[ ! -e "$runtime_dir/agents" ]] || leaks+=(agent-credentials)
[[ ! -e "$runtime_dir/proxies" ]] || leaks+=(proxy-private-runtime)
[[ ! -e "$runtime_dir/storage" ]] || leaks+=(storage-private-runtime)

slot_lock_owned=false
if [[ -s "$runtime_dir/state.env" ]]; then
  if [[ ! "${NYABASE_E2E_SLOT_LOCK:-}" =~ ^/tmp/nyabase-e2e-slot-([0-9]|1[0-5])\.lock$ ]] \
    || [[ ! -d "$NYABASE_E2E_SLOT_LOCK" ]] \
    || [[ "$(tr -d '\n' < "$NYABASE_E2E_SLOT_LOCK/run-id" 2>/dev/null || true)" != "$run_id" ]]; then
    leaks+=(slot-lock-ownership)
  else
    slot_lock_owned=true
  fi
fi

if ((${#leaks[@]} > 0)); then
  if [[ -s "$runtime_dir/manifest.json" ]]; then
    node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" cleanup \
      "$runtime_dir" "$run_id" failed "${leaks[*]}" || true
  fi
  die "cleanup leaked: ${leaks[*]}"
fi

if [[ ! -s "$cleanup_diagnostics" ]]; then
  rm -f "$cleanup_diagnostics"
  rmdir "$diagnostics_dir" 2>/dev/null || true
fi

if [[ "$slot_lock_owned" == true ]]; then
  if ! release_slot_lock "$run_id" "$NYABASE_E2E_SLOT_LOCK"; then
    if [[ -s "$runtime_dir/manifest.json" ]]; then
      node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" cleanup \
        "$runtime_dir" "$run_id" failed slot-lock-release || true
    fi
    die "cleanup leaked: slot-lock-release"
  fi
fi

if [[ -s "$runtime_dir/manifest.json" ]]; then
  node "$E2E_ROOT/e2e/orchestrator/manifest.mjs" cleanup \
    "$runtime_dir" "$run_id" clean
fi
if [[ "$keep_runtime" != true ]]; then
  rm -rf "$runtime_dir"
fi
log "down PASS: no labelled container, network, volume or image remains for $run_id"
