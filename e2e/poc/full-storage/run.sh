#!/usr/bin/env bash
set -Eeuo pipefail

IFS=$'\n\t'
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RUN_ID=${POC_RUN_ID:-"storage-poc-$(date -u +%Y%m%d%H%M%S)-$$"}
POC_SUBNET=${POC_SUBNET:-172.31.252.0/24}
POC_OSD_SIZE_GIB=${POC_OSD_SIZE_GIB:-6}
RUNTIME_ROOT=${POC_RUNTIME_ROOT:-/var/tmp}
EVIDENCE_DIR=${POC_EVIDENCE_DIR:-/tmp/nyabase-full-storage-poc-evidence}

if [[ ! "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]]; then
  echo 'POC_RUN_ID must match ^[a-z0-9][a-z0-9-]{0,47}$' >&2
  exit 2
fi

RUNTIME_DIR="${RUNTIME_ROOT%/}/nyabase-full-storage-poc-${RUN_ID}"
SECRET_DIR="$RUNTIME_DIR/secrets"
CEPH_DATA_DIR="$RUNTIME_DIR/ceph-data"
CEPH_ETC_DIR="$RUNTIME_DIR/ceph-etc"
NFS_EXPORT_DIR="$RUNTIME_DIR/nfs-export"
BACKING_FILE="$RUNTIME_DIR/ceph-osd.raw"
EVIDENCE_PATH="${EVIDENCE_DIR%/}/${RUN_ID}.env"

RUN_LABEL="io.nyabase.e2e.poc.run-id=${RUN_ID}"
POC_LABEL='io.nyabase.e2e.poc=full-storage'
MANAGED_LABEL='io.nyabase.e2e.managed=true'

NETWORK_NAME="nyabase-storage-poc-${RUN_ID}"
NFS_CONTAINER="nyabase-nfs-${RUN_ID}"
CEPH_CONTAINER="nyabase-ceph-${RUN_ID}"
CLIENT1_CONTAINER="nyabase-storage-client1-${RUN_ID}"
CLIENT2_CONTAINER="nyabase-storage-client2-${RUN_ID}"
NFS_IMAGE="nyabase-e2e-nfs:${RUN_ID}"
CEPH_IMAGE="nyabase-e2e-ceph:${RUN_ID}"
CLIENT_IMAGE="nyabase-e2e-storage-client:${RUN_ID}"

PHASE=preflight
RESULT=FAIL
BLOCKER='not started'
LOOP_DEVICE=''
CEPH_FSID=''
CEPH_BASE_DIGEST='unknown'
NFSD_BEFORE_HASH='unavailable'
NFSD_AFTER_HASH='unavailable'
NFSD_UNCHANGED=false
CEPH_MODULE_BEFORE=false
CEPH_MODULE_AFTER=false
SECRET_MODE='unavailable'
NFS_CLIENT1_FACTS='unavailable'
NFS_CLIENT2_FACTS='unavailable'
CEPH_CLIENT1_FACTS='unavailable'
CEPH_CLIENT2_FACTS='unavailable'
NFS_DATA_HASH='unavailable'
CEPH_DATA_HASH='unavailable'
CEPH_HEALTH='unavailable'
CEPH_DAEMON_FACTS='unavailable'
EXACT_UNMOUNTS=false
RESIDUAL_CONTAINERS=-1
RESIDUAL_NETWORKS=-1
RESIDUAL_VOLUMES=-1
RESIDUAL_IMAGES=-1
RESIDUAL_LOOPS=-1
declare -a CLEANUP_ERRORS=()

log() {
  printf '[full-storage-poc][%s] %s\n' "$PHASE" "$*"
}

die() {
  BLOCKER=$*
  printf '[full-storage-poc][%s] FAIL: %s\n' "$PHASE" "$BLOCKER" >&2
  exit 1
}

count_nonempty_lines() {
  awk 'NF { count += 1 } END { print count + 0 }'
}

redact_logs() {
  sed -E \
    -e 's/AQ[A-Za-z0-9+\/=]{16,}/<redacted-cephx>/g' \
    -e 's/((key|secret)[[:space:]]*[:=][[:space:]]*)[^[:space:],]+/\1<redacted>/Ig'
}

snapshot_host_nfsd() {
  local output=$1
  {
    printf '%s\n' '[mount]'
    findmnt -rn -t nfsd -o TARGET,SOURCE,FSTYPE,OPTIONS || true
    printf '%s\n' '[processes]'
    pgrep -a nfsd 2>/dev/null | sort -n || true
    printf '%s\n' '[listener]'
    ss -H -lntup 'sport = :2049' 2>/dev/null | sort || true
    printf '%s\n' '[versions]'
    if [[ -r /proc/fs/nfsd/versions ]]; then
      cat /proc/fs/nfsd/versions
    fi
    printf '%s\n' '[threads]'
    if [[ -r /proc/fs/nfsd/threads ]]; then
      cat /proc/fs/nfsd/threads
    fi
  } >"$output"
  chmod 0600 "$output"
}

on_error() {
  local rc=$?
  local line=${BASH_LINENO[0]:-unknown}
  if [[ -z "$BLOCKER" ]] || [[ "$BLOCKER" == 'not started' ]]; then
    BLOCKER="unexpected command failure in phase ${PHASE} at line ${line} (exit ${rc})"
  fi
  return "$rc"
}

cleanup() {
  local original_rc=$?
  local exit_phase=$PHASE
  local final_rc=1
  local container target image ids
  local cleanup_summary='none'
  local safe_blocker

  trap - ERR EXIT INT TERM
  set +e
  PHASE=cleanup

  if [[ "$RESULT" != PASS ]]; then
    for container in "$CEPH_CONTAINER" "$NFS_CONTAINER"; do
      if docker container inspect "$container" >/dev/null 2>&1; then
        printf '[full-storage-poc][cleanup] sanitized logs from %s:\n' "$container" >&2
        docker logs "$container" 2>&1 | tail -n 30 | redact_logs >&2
      fi
    done
    if [[ "$exit_phase" == readiness || "$exit_phase" == provision ]] && \
      docker container inspect "$CEPH_CONTAINER" >/dev/null 2>&1; then
      docker exec "$CEPH_CONTAINER" bash -c '
        for file in /var/log/ceph/ceph-mon.a.log /var/log/ceph/mon.log /var/log/ceph/mgr.log /var/log/ceph/osd.log /var/log/ceph/mds.log; do
          if [[ -f "$file" ]]; then
            printf "[%s]\n" "$file"
            tail -n 40 "$file"
          fi
        done
      ' 2>&1 | redact_logs >&2
    fi
    if [[ -f "$RUNTIME_DIR/ceph-data/log/ceph-volume-prepare.log" ]]; then
      tail -n 80 "$RUNTIME_DIR/ceph-data/log/ceph-volume-prepare.log" | redact_logs >&2
    fi
  fi

  for container in "$CLIENT2_CONTAINER" "$CLIENT1_CONTAINER"; do
    if docker container inspect "$container" >/dev/null 2>&1; then
      for target in /mnt/ceph /mnt/nfs; do
        if docker exec "$container" mountpoint -q "$target" >/dev/null 2>&1; then
          if ! timeout 30 docker exec "$container" umount "$target" >/dev/null 2>&1; then
            CLEANUP_ERRORS+=("normal unmount failed for ${container}:${target}")
          fi
        fi
      done
      if ! docker rm --force "$container" >/dev/null 2>&1; then
        CLEANUP_ERRORS+=("could not remove ${container}")
      fi
    fi
  done

  if docker container inspect "$CEPH_CONTAINER" >/dev/null 2>&1; then
    if ! docker stop --time 30 "$CEPH_CONTAINER" >/dev/null 2>&1; then
      CLEANUP_ERRORS+=("Ceph did not stop gracefully")
    fi
    if ! docker rm --force "$CEPH_CONTAINER" >/dev/null 2>&1; then
      CLEANUP_ERRORS+=("could not remove ${CEPH_CONTAINER}")
    fi
  fi
  if docker container inspect "$NFS_CONTAINER" >/dev/null 2>&1; then
    if ! docker stop --time 10 "$NFS_CONTAINER" >/dev/null 2>&1; then
      CLEANUP_ERRORS+=("Ganesha did not stop gracefully")
    fi
    if ! docker rm --force "$NFS_CONTAINER" >/dev/null 2>&1; then
      CLEANUP_ERRORS+=("could not remove ${NFS_CONTAINER}")
    fi
  fi

  if [[ -n "$LOOP_DEVICE" ]] && losetup "$LOOP_DEVICE" >/dev/null 2>&1; then
    if ! losetup --detach "$LOOP_DEVICE" >/dev/null 2>&1; then
      CLEANUP_ERRORS+=("could not detach exact loop ${LOOP_DEVICE}")
    fi
  fi

  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    if ! docker network rm "$NETWORK_NAME" >/dev/null 2>&1; then
      CLEANUP_ERRORS+=("could not remove ${NETWORK_NAME}")
    fi
  fi

  for image in "$CLIENT_IMAGE" "$NFS_IMAGE" "$CEPH_IMAGE"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      if ! docker image rm --force "$image" >/dev/null 2>&1; then
        CLEANUP_ERRORS+=("could not remove ${image}")
      fi
    fi
  done

  if [[ -f "$RUNTIME_DIR/nfsd.before" ]]; then
    snapshot_host_nfsd "$RUNTIME_DIR/nfsd.after"
    NFSD_AFTER_HASH=$(sha256sum "$RUNTIME_DIR/nfsd.after" | awk '{print $1}')
    if cmp --silent "$RUNTIME_DIR/nfsd.before" "$RUNTIME_DIR/nfsd.after"; then
      NFSD_UNCHANGED=true
    else
      NFSD_UNCHANGED=false
      CLEANUP_ERRORS+=("host kernel nfsd snapshot changed")
    fi
  fi

  if grep -qw ceph /proc/filesystems; then
    CEPH_MODULE_AFTER=true
  fi

  RESIDUAL_CONTAINERS=$(docker ps --all --quiet --filter "label=$RUN_LABEL" | count_nonempty_lines)
  RESIDUAL_NETWORKS=$(docker network ls --quiet --filter "label=$RUN_LABEL" | count_nonempty_lines)
  RESIDUAL_VOLUMES=$(docker volume ls --quiet --filter "label=$RUN_LABEL" | count_nonempty_lines)
  RESIDUAL_IMAGES=$(docker image ls --quiet --filter "label=$RUN_LABEL" | sort -u | count_nonempty_lines)
  if [[ -f "$BACKING_FILE" ]]; then
    RESIDUAL_LOOPS=$(losetup --associated "$BACKING_FILE" | count_nonempty_lines)
  else
    RESIDUAL_LOOPS=0
  fi

  if (( RESIDUAL_CONTAINERS != 0 || RESIDUAL_NETWORKS != 0 || RESIDUAL_VOLUMES != 0 || RESIDUAL_IMAGES != 0 || RESIDUAL_LOOPS != 0 )); then
    CLEANUP_ERRORS+=("run-labelled or loop resources remain")
  fi

  case "$RUNTIME_DIR" in
    "${RUNTIME_ROOT%/}"/nyabase-full-storage-poc-"$RUN_ID")
      rm -rf -- "$RUNTIME_DIR"
      ;;
    *)
      CLEANUP_ERRORS+=("refused unsafe runtime deletion path")
      ;;
  esac

  install -d -m 0700 "$EVIDENCE_DIR"
  if (( ${#CLEANUP_ERRORS[@]} > 0 )); then
    cleanup_summary=$(IFS=';'; printf '%s' "${CLEANUP_ERRORS[*]}")
    if [[ "$RESULT" == PASS ]]; then
      RESULT=FAIL
      BLOCKER="cleanup proof failed: ${cleanup_summary}"
    fi
  fi

  safe_blocker=${BLOCKER//$'\n'/ }
  {
    printf 'run_id=%s\n' "$RUN_ID"
    printf 'result=%s\n' "$RESULT"
    printf 'blocker=%s\n' "$safe_blocker"
    printf 'subnet=%s\n' "$POC_SUBNET"
    printf 'ceph_base_digest=%s\n' "$CEPH_BASE_DIGEST"
    printf 'ceph_fsid=%s\n' "$CEPH_FSID"
    printf 'ceph_osd_device=%s\n' "$LOOP_DEVICE"
    printf 'ceph_health=%s\n' "$CEPH_HEALTH"
    printf 'ceph_daemons=%s\n' "$CEPH_DAEMON_FACTS"
    printf 'nfs_client1_mount=%s\n' "$NFS_CLIENT1_FACTS"
    printf 'nfs_client2_mount=%s\n' "$NFS_CLIENT2_FACTS"
    printf 'ceph_client1_mount=%s\n' "$CEPH_CLIENT1_FACTS"
    printf 'ceph_client2_mount=%s\n' "$CEPH_CLIENT2_FACTS"
    printf 'nfs_cross_client_sha256=%s\n' "$NFS_DATA_HASH"
    printf 'ceph_cross_client_sha256=%s\n' "$CEPH_DATA_HASH"
    printf 'secret_file_mode=%s\n' "$SECRET_MODE"
    printf 'exact_unmounts=%s\n' "$EXACT_UNMOUNTS"
    printf 'host_nfsd_before_sha256=%s\n' "$NFSD_BEFORE_HASH"
    printf 'host_nfsd_after_sha256=%s\n' "$NFSD_AFTER_HASH"
    printf 'host_nfsd_unchanged=%s\n' "$NFSD_UNCHANGED"
    printf 'ceph_module_before=%s\n' "$CEPH_MODULE_BEFORE"
    printf 'ceph_module_after=%s\n' "$CEPH_MODULE_AFTER"
    printf 'residual_containers=%s\n' "$RESIDUAL_CONTAINERS"
    printf 'residual_networks=%s\n' "$RESIDUAL_NETWORKS"
    printf 'residual_volumes=%s\n' "$RESIDUAL_VOLUMES"
    printf 'residual_images=%s\n' "$RESIDUAL_IMAGES"
    printf 'residual_loops=%s\n' "$RESIDUAL_LOOPS"
    printf 'cleanup_errors=%s\n' "$cleanup_summary"
  } >"$EVIDENCE_PATH"
  chmod 0600 "$EVIDENCE_PATH"

  if [[ "$RESULT" == PASS ]] && (( ${#CLEANUP_ERRORS[@]} == 0 )); then
    final_rc=0
  elif (( original_rc != 0 )); then
    final_rc=$original_rc
  fi

  printf '[full-storage-poc][cleanup] result=%s containers=%s networks=%s volumes=%s images=%s loops=%s nfsd_unchanged=%s\n' \
    "$RESULT" "$RESIDUAL_CONTAINERS" "$RESIDUAL_NETWORKS" "$RESIDUAL_VOLUMES" "$RESIDUAL_IMAGES" "$RESIDUAL_LOOPS" "$NFSD_UNCHANGED"
  printf '[full-storage-poc][cleanup] evidence=%s\n' "$EVIDENCE_PATH"
  exit "$final_rc"
}

trap on_error ERR
trap cleanup EXIT
trap 'BLOCKER="interrupted by SIGINT"; exit 130' INT
trap 'BLOCKER="interrupted by SIGTERM"; exit 143' TERM

for command in awk bash cmp date df docker findmnt grep ip losetup modinfo mountpoint pgrep python3 sed sha256sum ss stat timeout truncate; do
  command -v "$command" >/dev/null 2>&1 || die "required host command is missing: ${command}"
done
[[ $EUID -eq 0 ]] || die 'root is required for exact loop-device ownership and privileged kernel mounts'
[[ -d "$RUNTIME_ROOT" ]] || die "runtime root does not exist: ${RUNTIME_ROOT}"
[[ "$POC_OSD_SIZE_GIB" =~ ^[0-9]+$ ]] || die 'POC_OSD_SIZE_GIB must be an integer'
(( POC_OSD_SIZE_GIB >= 5 && POC_OSD_SIZE_GIB <= 12 )) || die 'POC_OSD_SIZE_GIB must be between 5 and 12'
(( $(nproc) >= 2 )) || die 'at least two CPU cores are required'

available_kib=$(df -Pk "$RUNTIME_ROOT" | awk 'NR == 2 { print $4 }')
(( available_kib >= 8 * 1024 * 1024 )) || die 'at least 8 GiB free space is required on the runtime filesystem'
available_memory_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
(( available_memory_kib >= 6 * 1024 * 1024 )) || die 'at least 6 GiB available memory is required'
docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'
docker run --rm --privileged --label "$RUN_LABEL" alpine:latest true >/dev/null 2>&1 || die 'Docker privileged containers are unavailable'
[[ -e /dev/loop-control ]] || die '/dev/loop-control is unavailable'
losetup --find >/dev/null 2>&1 || die 'no free loop device is available'
modinfo ceph >/dev/null 2>&1 || die "Ceph kernel module is unavailable for kernel $(uname -r)"

mapfile -t occupied_cidrs < <(
  ip -o -4 route show | awk '$1 != "default" { print $1 }'
  while IFS= read -r network; do
    docker network inspect "$network" --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}'
  done < <(docker network ls --quiet)
)
if ! network_prefix=$(python3 - "$POC_SUBNET" "${occupied_cidrs[@]}" <<'PY'
import ipaddress
import sys

try:
    candidate = ipaddress.ip_network(sys.argv[1], strict=True)
except ValueError as error:
    print(error, file=sys.stderr)
    raise SystemExit(2)
if candidate.version != 4 or candidate.prefixlen != 24:
    print('PoC subnet must be an IPv4 /24', file=sys.stderr)
    raise SystemExit(2)
for raw in sys.argv[2:]:
    try:
        occupied = ipaddress.ip_network(raw, strict=False)
    except ValueError:
        continue
    if candidate.overlaps(occupied):
        print(f'PoC subnet {candidate} overlaps {occupied}', file=sys.stderr)
        raise SystemExit(1)
parts = str(candidate.network_address).split('.')
print('.'.join(parts[:3]))
PY
); then
  die "requested PoC subnet is invalid or overlaps an existing route/network: ${POC_SUBNET}"
fi

NFS_IP="${network_prefix}.8"
CEPH_IP="${network_prefix}.9"
CLIENT1_IP="${network_prefix}.21"
CLIENT2_IP="${network_prefix}.22"

stale_containers=$(docker ps --all --quiet --filter "label=$POC_LABEL" | count_nonempty_lines)
stale_networks=$(docker network ls --quiet --filter "label=$POC_LABEL" | count_nonempty_lines)
stale_volumes=$(docker volume ls --quiet --filter "label=$POC_LABEL" | count_nonempty_lines)
stale_images=$(docker image ls --quiet --filter "label=$POC_LABEL" | sort -u | count_nonempty_lines)
(( stale_containers == 0 && stale_networks == 0 && stale_volumes == 0 && stale_images == 0 )) || \
  die 'stale full-storage PoC Docker resources exist; ownership must be inspected before a new run'
if losetup --all | grep -F 'nyabase-full-storage-poc-' >/dev/null 2>&1; then
  die 'stale full-storage PoC loop device exists; ownership must be inspected before a new run'
fi

install -d -m 0700 "$RUNTIME_DIR" "$SECRET_DIR" "$CEPH_DATA_DIR" "$CEPH_ETC_DIR" "$NFS_EXPORT_DIR"
snapshot_host_nfsd "$RUNTIME_DIR/nfsd.before"
NFSD_BEFORE_HASH=$(sha256sum "$RUNTIME_DIR/nfsd.before" | awk '{print $1}')
if grep -qw ceph /proc/filesystems; then
  CEPH_MODULE_BEFORE=true
fi

CEPH_BASE_DIGEST=$(docker image inspect quay.io/ceph/ceph:v19.2.3 \
  --format '{{join .RepoDigests ","}}' 2>/dev/null || printf 'not-cached-before-build')
log "preflight passed: cpu=$(nproc) free_kib=${available_kib} mem_available_kib=${available_memory_kib} subnet=${POC_SUBNET}"

PHASE=build
BLOCKER='image build failed'
log 'building pinned Ceph, userspace Ganesha, and kernel-mount client images'
docker build --quiet --label "$RUN_LABEL" --label "$POC_LABEL" --label "$MANAGED_LABEL" \
  --tag "$CEPH_IMAGE" "$SCRIPT_DIR/ceph" >/dev/null || die 'Ceph wrapper image build failed'
docker build --quiet --label "$RUN_LABEL" --label "$POC_LABEL" --label "$MANAGED_LABEL" \
  --tag "$NFS_IMAGE" "$SCRIPT_DIR/nfs" >/dev/null || die 'NFS-Ganesha image build failed'
docker build --quiet --label "$RUN_LABEL" --label "$POC_LABEL" --label "$MANAGED_LABEL" \
  --tag "$CLIENT_IMAGE" "$SCRIPT_DIR/client" >/dev/null || die 'storage client image build failed'

PHASE=provision
BLOCKER='storage fixture provisioning failed'
CEPH_FSID=$(cat /proc/sys/kernel/random/uuid)
truncate --size "${POC_OSD_SIZE_GIB}G" "$BACKING_FILE"
chmod 0600 "$BACKING_FILE"
LOOP_DEVICE=$(losetup --find --show "$BACKING_FILE")
[[ -b "$LOOP_DEVICE" ]] || die 'losetup did not return a usable block device'
log "allocated exact BlueStore loop device ${LOOP_DEVICE}"

docker network create \
  --driver bridge \
  --subnet "$POC_SUBNET" \
  --label "$RUN_LABEL" \
  --label "$POC_LABEL" \
  --label "$MANAGED_LABEL" \
  "$NETWORK_NAME" >/dev/null || die 'isolated Docker network creation failed'

docker run --detach \
  --name "$NFS_CONTAINER" \
  --hostname nfs-ganesha \
  --network "$NETWORK_NAME" \
  --ip "$NFS_IP" \
  --label "$RUN_LABEL" \
  --label "$POC_LABEL" \
  --label "$MANAGED_LABEL" \
  --privileged \
  --cpus 0.75 \
  --memory 768m \
  --stop-timeout 10 \
  --env "NFS_CLIENT_CIDR=$POC_SUBNET" \
  --mount "type=bind,src=${NFS_EXPORT_DIR},dst=/srv/export" \
  "$NFS_IMAGE" >/dev/null || die 'NFS-Ganesha container failed to start'

docker run --detach \
  --name "$CEPH_CONTAINER" \
  --hostname ceph \
  --network "$NETWORK_NAME" \
  --ip "$CEPH_IP" \
  --label "$RUN_LABEL" \
  --label "$POC_LABEL" \
  --label "$MANAGED_LABEL" \
  --privileged \
  --cpus 2 \
  --memory 4g \
  --memory-swap 4g \
  --ulimit nofile=1048576:1048576 \
  --stop-timeout 30 \
  --env "CEPH_FSID=$CEPH_FSID" \
  --env "CEPH_IP=$CEPH_IP" \
  --env "CEPH_NETWORK=$POC_SUBNET" \
  --env "CEPH_OSD_DEVICE=$LOOP_DEVICE" \
  --mount "type=bind,src=${CEPH_DATA_DIR},dst=/var/lib/ceph" \
  --mount "type=bind,src=${CEPH_ETC_DIR},dst=/etc/ceph" \
  --mount "type=bind,src=${SECRET_DIR},dst=/run/nyabase-secrets" \
  "$CEPH_IMAGE" >/dev/null || die 'Ceph container failed to start'

PHASE=readiness
BLOCKER='Ceph did not become ready'
for attempt in $(seq 1 300); do
  if [[ -f "$SECRET_DIR/ready" ]]; then
    break
  fi
  if [[ $(docker inspect --format '{{.State.Running}}' "$CEPH_CONTAINER" 2>/dev/null) != true ]]; then
    die 'Ceph container exited before cluster readiness'
  fi
  sleep 1
done
[[ -f "$SECRET_DIR/ready" ]] || die 'Ceph mon/mgr/OSD/MDS did not become ready within 300 seconds'
[[ $(docker inspect --format '{{.State.Running}}' "$NFS_CONTAINER" 2>/dev/null) == true ]] || \
  die 'NFS-Ganesha exited before client mounts'

CLIENT_SECRET="$SECRET_DIR/ceph.client.nyabase.secret"
[[ -s "$CLIENT_SECRET" ]] || die 'Ceph client secret file was not created'
SECRET_MODE=$(stat --format '%a' "$CLIENT_SECRET")
[[ "$SECRET_MODE" == 600 ]] || die "Ceph client secret mode is ${SECRET_MODE}, expected 600"
while IFS= read -r keyring; do
  mode=$(stat --format '%a' "$keyring")
  [[ "$mode" == 600 ]] || die "Ceph keyring is not mode 0600: ${keyring}"
done < <(find "$CEPH_DATA_DIR" "$CEPH_ETC_DIR" -type f -name '*keyring*' -print)

start_client() {
  local name=$1
  local ip=$2
  docker run --detach \
    --name "$name" \
    --hostname "$name" \
    --network "$NETWORK_NAME" \
    --ip "$ip" \
    --label "$RUN_LABEL" \
    --label "$POC_LABEL" \
    --label "$MANAGED_LABEL" \
    --privileged \
    --cpus 0.75 \
    --memory 768m \
    --stop-timeout 5 \
    --tmpfs /mnt:rw,nosuid,nodev,size=64m \
    --mount type=bind,src=/lib/modules,dst=/lib/modules,readonly \
    --mount "type=bind,src=${CLIENT_SECRET},dst=/run/secrets/ceph.client.nyabase.secret,readonly" \
    "$CLIENT_IMAGE" >/dev/null
  docker exec "$name" mkdir -p /mnt/nfs /mnt/ceph
}

start_client "$CLIENT1_CONTAINER" "$CLIENT1_IP" || die 'first independent storage client failed to start'
start_client "$CLIENT2_CONTAINER" "$CLIENT2_IP" || die 'second independent storage client failed to start'

timeout 30 docker exec "$CLIENT1_CONTAINER" modprobe ceph >/dev/null || \
  die "kernel Ceph module could not be loaded for $(uname -r)"
timeout 30 docker exec "$CLIENT1_CONTAINER" modprobe nfs >/dev/null || \
  die "kernel NFS client module could not be loaded for $(uname -r)"

if ! timeout 60 docker exec --env "NFS_IP=$NFS_IP" "$CLIENT1_CONTAINER" bash -c '
  for _ in $(seq 1 50); do
    if exec 3<>"/dev/tcp/${NFS_IP}/2049"; then
      exec 3>&-
      exec 3<&-
      exit 0
    fi
    sleep 1
  done
  exit 1
' >/dev/null 2>&1; then
  die 'NFS-Ganesha did not accept TCP connections on its isolated address'
fi

mount_client() {
  local name=$1
  if ! timeout 60 docker exec "$name" mount -t nfs \
    -o vers=4.2,proto=tcp,hard,timeo=50,retrans=2,nosharecache,noac,lookupcache=none \
    "${NFS_IP}:/nyabase" /mnt/nfs; then
    return 1
  fi
  if ! timeout 90 docker exec "$name" mount -t ceph \
    "${CEPH_IP}:6789:/" /mnt/ceph \
    -o name=nyabase,fs=nyabasefs,secretfile=/run/secrets/ceph.client.nyabase.secret; then
    return 1
  fi
  docker exec "$name" mountpoint -q /mnt/nfs || return 1
  docker exec "$name" mountpoint -q /mnt/ceph || return 1
}

PHASE=kernel-mount
BLOCKER='kernel mounts failed'
mount_client "$CLIENT1_CONTAINER" || die 'first client could not kernel-mount NFS and CephFS'
mount_client "$CLIENT2_CONTAINER" || die 'second client could not kernel-mount NFS and CephFS'

NFS_CLIENT1_FACTS=$(docker exec "$CLIENT1_CONTAINER" findmnt --noheadings --raw --output FSTYPE,SOURCE --mountpoint /mnt/nfs)
NFS_CLIENT2_FACTS=$(docker exec "$CLIENT2_CONTAINER" findmnt --noheadings --raw --output FSTYPE,SOURCE --mountpoint /mnt/nfs)
CEPH_CLIENT1_FACTS=$(docker exec "$CLIENT1_CONTAINER" findmnt --noheadings --raw --output FSTYPE,SOURCE --mountpoint /mnt/ceph)
CEPH_CLIENT2_FACTS=$(docker exec "$CLIENT2_CONTAINER" findmnt --noheadings --raw --output FSTYPE,SOURCE --mountpoint /mnt/ceph)
[[ "$NFS_CLIENT1_FACTS" == nfs4* && "$NFS_CLIENT2_FACTS" == nfs4* ]] || \
  die 'NFS mounts are not kernel nfs4 mounts on both clients'
[[ "$CEPH_CLIENT1_FACTS" == ceph* && "$CEPH_CLIENT2_FACTS" == ceph* ]] || \
  die 'CephFS mounts are not kernel ceph mounts on both clients'

PHASE=cross-client-io
BLOCKER='cross-client shared-data probe failed'
NFS_MARKER1="${RUN_ID}:nfs:client1"
NFS_MARKER2="${RUN_ID}:nfs:client2"
CEPH_MARKER1="${RUN_ID}:ceph:client1"
CEPH_MARKER2="${RUN_ID}:ceph:client2"

marker_hash() {
  printf '%s\n' "$1" | sha256sum | awk '{print $1}'
}

mounted_file_hash() {
  local container=$1
  local path=$2
  docker exec "$container" sha256sum "$path" | awk '{print $1}'
}

wait_for_shared_hash() {
  local container=$1
  local path=$2
  local expected=$3
  local attempt actual
  for attempt in $(seq 1 15); do
    actual=$(mounted_file_hash "$container" "$path" 2>/dev/null || true)
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

docker exec --env "MARKER=$NFS_MARKER1" "$CLIENT1_CONTAINER" sh -c \
  'printf "%s\n" "$MARKER" > /mnt/nfs/from-client1 && sync -f /mnt/nfs/from-client1'
docker exec --env "MARKER=$CEPH_MARKER1" "$CLIENT1_CONTAINER" sh -c \
  'printf "%s\n" "$MARKER" > /mnt/ceph/from-client1 && sync -f /mnt/ceph/from-client1'
NFS_MARKER1_HASH=$(marker_hash "$NFS_MARKER1")
CEPH_MARKER1_HASH=$(marker_hash "$CEPH_MARKER1")
if ! wait_for_shared_hash "$CLIENT2_CONTAINER" /mnt/nfs/from-client1 "$NFS_MARKER1_HASH"; then
  nfs_writer_hash=$(mounted_file_hash "$CLIENT1_CONTAINER" /mnt/nfs/from-client1 2>/dev/null || printf missing)
  nfs_reader_hash=$(mounted_file_hash "$CLIENT2_CONTAINER" /mnt/nfs/from-client1 2>/dev/null || printf missing)
  nfs_server_hash=$(docker exec "$NFS_CONTAINER" sha256sum /srv/export/from-client1 2>/dev/null | awk '{print $1}' || printf missing)
  die "client2 NFS hash mismatch expected=${NFS_MARKER1_HASH} writer=${nfs_writer_hash} server=${nfs_server_hash} reader=${nfs_reader_hash}"
fi
wait_for_shared_hash "$CLIENT2_CONTAINER" /mnt/ceph/from-client1 "$CEPH_MARKER1_HASH" || \
  die 'client2 did not read client1 CephFS data with the expected hash'

docker exec --env "MARKER=$NFS_MARKER2" "$CLIENT2_CONTAINER" sh -c \
  'printf "%s\n" "$MARKER" > /mnt/nfs/from-client2 && sync -f /mnt/nfs/from-client2'
docker exec --env "MARKER=$CEPH_MARKER2" "$CLIENT2_CONTAINER" sh -c \
  'printf "%s\n" "$MARKER" > /mnt/ceph/from-client2 && sync -f /mnt/ceph/from-client2'
NFS_MARKER2_HASH=$(marker_hash "$NFS_MARKER2")
CEPH_MARKER2_HASH=$(marker_hash "$CEPH_MARKER2")
wait_for_shared_hash "$CLIENT1_CONTAINER" /mnt/nfs/from-client2 "$NFS_MARKER2_HASH" || \
  die 'client1 did not read client2 NFS data with the expected hash'
wait_for_shared_hash "$CLIENT1_CONTAINER" /mnt/ceph/from-client2 "$CEPH_MARKER2_HASH" || \
  die 'client1 did not read client2 CephFS data with the expected hash'

NFS_DATA_HASH=$(printf '%s\n%s\n' "$NFS_MARKER1" "$NFS_MARKER2" | sha256sum | awk '{print $1}')
CEPH_DATA_HASH=$(printf '%s\n%s\n' "$CEPH_MARKER1" "$CEPH_MARKER2" | sha256sum | awk '{print $1}')

docker exec "$CEPH_CONTAINER" ceph mon stat | grep -q '1 mons' || die 'Ceph monitor count is not one'
docker exec "$CEPH_CONTAINER" ceph osd stat | grep -q '1 osds: 1 up' || die 'Ceph OSD is not up'
docker exec "$CEPH_CONTAINER" ceph mds stat | grep -q 'up:active' || die 'Ceph MDS is not active'
CEPH_HEALTH=$(docker exec "$CEPH_CONTAINER" ceph health | awk '{print $1}')
CEPH_DAEMON_FACTS='mon:1,mgr:1,osd_up_in:1,mds_active:1'

PHASE=exact-unmount
BLOCKER='exact unmount proof failed'
for container in "$CLIENT2_CONTAINER" "$CLIENT1_CONTAINER"; do
  for target in /mnt/ceph /mnt/nfs; do
    timeout 60 docker exec "$container" umount "$target" || \
      die "normal exact unmount failed for ${container}:${target}"
    if docker exec "$container" mountpoint -q "$target"; then
      die "mount remains after exact unmount for ${container}:${target}"
    fi
  done
done
EXACT_UNMOUNTS=true

docker rm --force "$CLIENT2_CONTAINER" "$CLIENT1_CONTAINER" >/dev/null

RESULT=PASS
BLOCKER=none
PHASE=complete
log "real NFS and CephFS kernel-mount PoC passed; cleanup proof follows"
