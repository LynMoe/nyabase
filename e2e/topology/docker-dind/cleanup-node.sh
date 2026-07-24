#!/usr/bin/env bash
set -euo pipefail

runtime=/var/lib/nyabase-e2e
xfs_mount=/mnt/nyabase-xfs
docker_root=/var/lib/nyabase-docker
data_root=/data/nyabase

docker_socket=/run/nyabase-agent/docker.sock
if [[ -S "$docker_socket" && ! -L "$docker_socket" ]]; then
  # Partial bootstrap can leave the exact private socket inode behind while
  # the daemon is already dead. Treat an unqueryable socket as stale and
  # continue with service/mount teardown; never let it strand the outer run.
  if inner_ids="$(timeout 15 docker -H "unix://$docker_socket" ps -aq 2>/dev/null)"; then
    if [[ -n "$inner_ids" ]]; then
      mapfile -t inner_containers <<<"$inner_ids"
      timeout 30 docker -H "unix://$docker_socket" rm -f "${inner_containers[@]}" >/dev/null
      [[ -z "$(timeout 15 docker -H "unix://$docker_socket" ps -aq)" ]]
    fi
  fi
fi

systemctl stop nyabase-agent.service nyabase-docker.service 2>/dev/null || true
! systemctl is-active --quiet nyabase-agent.service
! systemctl is-active --quiet nyabase-docker.service
rm -f "$docker_socket"

# Provider-owned EBUSY probes are exact sleep processes whose cwd is one
# Backend-derived RemoteFS mount. Stop only those recorded identities before
# unmounting every physical RemoteFS target in this private node namespace.
for pid_file in /run/nyabase-e2e/remote-fs-busy-*.pid; do
  [[ -f "$pid_file" ]] || continue
  pid="$(tr -d '\n' < "$pid_file")"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" == sleep ]] \
    && [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" == /mnt/remote-fs/* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
done
mapfile -t remote_mounts < <(
  findmnt -rn -o TARGET \
    | awk 'index($0, "/mnt/remote-fs/") == 1 { print }' \
    | sort -r
)
for target in "${remote_mounts[@]}"; do
  umount "$target"
done
rm -rf /run/nyabase-cephfs
[[ -z "$(findmnt -rn -o TARGET | awk 'index($0, "/mnt/remote-fs/") == 1 { print }')" ]]

mountpoint -q "$data_root" && umount "$data_root" || true
mountpoint -q "$docker_root" && umount "$docker_root" || true
mountpoint -q "$xfs_mount" && umount "$xfs_mount" || true

if [[ -s "$runtime/loop-device" ]]; then
  loopdev="$(tr -d '\n' < "$runtime/loop-device")"
  [[ "$loopdev" =~ ^/dev/loop[0-9]+$ ]]
  if losetup "$loopdev" >/dev/null 2>&1; then
    backing="$(losetup -n -O BACK-FILE "$loopdev")"
    canonical_backing="$(readlink -f "$backing")"
    [[ "$canonical_backing" == "$runtime"/*.xfs ]]
    [[ "$(dirname "$canonical_backing")" == "$runtime" ]]
    losetup -d "$loopdev"
  fi
  ! losetup "$loopdev" >/dev/null 2>&1
fi

rm -f "$runtime/ready"
! findmnt -rn --mountpoint "$data_root" >/dev/null 2>&1
! findmnt -rn --mountpoint "$docker_root" >/dev/null 2>&1
! findmnt -rn --mountpoint "$xfs_mount" >/dev/null 2>&1
