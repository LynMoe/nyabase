#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
run_id="$(require_run_id "${1:-}")"
load_run "$run_id"

[[ "$NYABASE_E2E_PROFILE" == full ]] || die 'storage health is owned only by the Full profile'
# shellcheck disable=SC1090
source "$NYABASE_E2E_RUNTIME_DIR/build.env"

nfs_name="$NYABASE_E2E_PREFIX-nfs-fixture"
ceph_name="$NYABASE_E2E_PREFIX-cephfs-fixture"
secret="$NYABASE_E2E_RUNTIME_DIR/storage/secrets/ceph.client.nyabase.secret"

assert_fixture() {
  local name="$1" component="$2" expected_image="$3" expected_ip="$4"
  [[ "$(docker inspect "$name" --format '{{.State.Running}}')" == true ]] \
    || die "$component is not running"
  [[ "$(docker inspect "$name" --format '{{index .Config.Labels "io.nyabase.e2e.run-id"}}')" == "$run_id" ]] \
    || die "$component run ownership mismatch"
  [[ "$(docker inspect "$name" --format '{{index .Config.Labels "io.nyabase.e2e.component"}}')" == "$component" ]] \
    || die "$component identity mismatch"
  [[ "$(docker inspect "$name" --format '{{.Image}}')" == "$expected_image" ]] \
    || die "$component is not running the current Full build image"
  [[ "$(docker inspect "$name" --format "{{with index .NetworkSettings.Networks \"$NYABASE_E2E_NETWORK\"}}{{.IPAddress}}{{end}}")" == "$expected_ip" ]] \
    || die "$component address mismatch"
}

assert_fixture "$nfs_name" nfs-fixture "$NFS_FIXTURE_IMAGE_ID" "$NYABASE_E2E_NFS_IP"
assert_fixture "$ceph_name" cephfs-fixture "$CEPH_FIXTURE_IMAGE_ID" "$NYABASE_E2E_CEPH_IP"
[[ -s "$secret" && "$(stat -c '%a' "$secret")" == 600 ]] \
  || die 'CephFS client credential is absent or not mode 0600'
[[ -s "$NYABASE_E2E_RUNTIME_DIR/storage/nfs-fixture.json" ]] \
  || die 'NFS fixture descriptor is absent'
[[ -s "$NYABASE_E2E_RUNTIME_DIR/storage/cephfs-fixture.json" ]] \
  || die 'CephFS fixture descriptor is absent'
[[ -s "$NYABASE_E2E_RUNTIME_DIR/storage-readiness.json" ]] \
  || die 'Full storage readiness evidence is absent'

docker exec "$ceph_name" ceph mon stat | grep -q '1 mons'
docker exec "$ceph_name" ceph osd stat | grep -Eq '1 osds: 1 up.*1 in'
docker exec "$ceph_name" ceph mds stat | grep -q 'up:active'

independent="$NYABASE_E2E_PREFIX-independent-client"
nfs_port_ready=false
for _ in $(seq 1 30); do
  if docker exec "$independent" nc -z -w 2 "$NYABASE_E2E_NFS_IP" 2049 >/dev/null 2>&1; then
    nfs_port_ready=true
    break
  fi
  sleep 0.2
done
[[ "$nfs_port_ready" == true ]] || die 'NFS fixture TCP/2049 health failed'

for node_key in node1 node2; do
  node_name="$NYABASE_E2E_PREFIX-$node_key"
  docker exec "$node_name" sh -eu -c \
    'test ! -d /run/nyabase-cephfs || test -z "$(find /run/nyabase-cephfs -mindepth 1 -print -quit)"'
done

log 'Full storage health PASS: current NFS/CephFS fixtures, daemons, descriptors and secret hygiene are ready'
